"""Read-only analysis of immutable observations against current API/plan inputs."""
from __future__ import annotations

import base64
import hashlib
import json
import time
from bisect import bisect_left
from datetime import date, datetime, timedelta, timezone

from .. import db, db_hf_balance, manage_db
from ..hf_balance_contract import amount
from .hf_org_usage import DAY_MS, today_start, usage_days

KST = timezone(timedelta(hours=9))
FIRST_COMPLETE_DAY = 1769958000000


class AnalysisChanged(ValueError):
    pass


def period(start=None, end=None, *, at=None):
    today = datetime.fromtimestamp((at or int(time.time() * 1000)) / 1000, KST).date()
    try:
        last = date.fromisoformat(end) if end else today + timedelta(days=1)
        first = date.fromisoformat(start) if start else last - timedelta(days=7)
        if start and first.isoformat() != start or end and last.isoformat() != end:
            raise ValueError
    except ValueError as exc:
        raise ValueError('invalid_period') from exc
    if not 0 < (last - first).days <= 31:
        raise ValueError('period_limit')
    return tuple(int(datetime.combine(d, datetime.min.time(), KST).timestamp() * 1000) for d in (first, last))


def coverage(data, start, end):
    """Unlike quota's short-tail rule, an observed interval needs its entire range."""
    cfg = data['config']
    if not cfg.get('org_id'):
        return [], 'not_configured'
    if cfg.get('restore_paused'):
        return [], 'restore_paused'
    if not cfg.get('enabled'):
        return [], 'collection_disabled'
    if start < FIRST_COMPLETE_DAY:
        return [], 'before_api_start'
    if end - start > 31 * DAY_MS:
        return [], 'interval_limit'
    if end <= start:
        return [], 'invalid_interval'
    selected = []
    for day in range(today_start(start), end, DAY_MS):
        matches = [w for w in data['windows'] if w['kind'] == 'day' and w['start_ms'] == day]
        if len(matches) != 1 or not matches[0]['snapshot_version']:
            return [], 'missing_day'
        w = matches[0]
        if w.get('contract_version', 1) != 1 or w['end_ms'] != day + DAY_MS:
            return [], 'contract_mismatch'
        if not w['success_complete'] or w['actual_start_ms'] != day:
            return [], 'incomplete_day'
        if any(c['state'] in ('mismatch', 'duplicate') and c['start_ms'] < min(end, day + DAY_MS)
               and c['end_ms'] > max(start, day) for c in data['checks']):
            return [], 'daily_mismatch'
        if (w['actual_end_ms'] or day) < min(end, day + DAY_MS):
            return [], 'unfinished_day'
        selected.append(w)
    ids = {w['id'] for w in selected}
    duplicates = data.get('duplicate_windows')
    if duplicates is None:
        rows = [r for r in data['rows'] if r['window_id'] in ids]
        duplicate = len({r['row_id'] for r in rows}) != len(rows)
    else:
        duplicate = any(len(ids & windows) > 1 for windows in duplicates)
    if duplicate:
        return [], 'duplicate_row'
    if not data['workspace_proven']:
        return [], 'workspace_unproven'
    return selected, None


def interval(data, first, last, workspace_id):
    start, end = first['observed_at_ms'], last['observed_at_ms']
    selected, reason = coverage(data, start, end)
    ids = {w['id'] for w in selected}
    uncertain = first.get('conflict') or last.get('conflict') or any(
        r['precision_error_c'] is None for r in (first, last))
    tolerance = None if uncertain else first['precision_error_c'] + last['precision_error_c']
    delta = last['credits_c'] - first['credits_c']
    net = None if reason else _net(data, ids, workspace_id, start, end)
    residual = None if net is None or first.get('conflict') or last.get('conflict') else delta + net
    state = ('observation_uncertain' if uncertain else
             'comparison_unavailable' if reason in ('workspace_unproven', 'before_api_start', 'interval_limit', 'invalid_interval',
                                                   'not_configured', 'restore_paused', 'collection_disabled', 'contract_mismatch') else
             'api_pending' if reason else 'numeric_match' if abs(residual) <= tolerance else 'residual_present')
    reasons = ([reason] if reason else []) + (['observation_uncertain'] if uncertain else [])
    if any(r['precision_error_c'] is None for r in (first, last)):
        reasons.append('precision_unknown')
    return dict(from_observation_id=first['observation_id'], to_observation_id=last['observation_id'],
                start_ms=start, end_ms=end, opening_c=None if first.get('conflict') else first['credits_c'],
                closing_c=None if last.get('conflict') else last['credits_c'],
                delta_c=None if first.get('conflict') or last.get('conflict') else delta,
                api_created_net_c=net, residual_c=residual, tolerance_c=tolerance, state=state,
                candidate_classification='unclassified', candidate_evidence=[], candidate_count=0, reason_codes=reasons)


def _net(data, ids, workspace_id, start, end):
    if 'net_index' not in data:
        return sum(r['credits_c'] for r in data['rows'] if r['window_id'] in ids and r['workspace_id'] == workspace_id
                   and start <= r['created_at'] < end)
    total = 0
    for wid in ids:
        times, prefix = data['net_index'].get((wid, workspace_id), ([], [0]))
        total += prefix[bisect_left(times, end)] - prefix[bisect_left(times, start)]
    return total


def _prepare(data):
    groups, row_windows, refunds, daily_totals = {}, {}, {}, {}
    valid = _proof_windows(data['windows'], data['checks'])
    for row in data['rows']:
        groups.setdefault((row['window_id'], row['workspace_id']), []).append((row['created_at'], row['credits_c']))
        row_windows.setdefault(row['row_id'], set()).add(row['window_id'])
        totals = daily_totals.setdefault((row['window_id'], row['workspace_id']), [0, 0, 0])
        for index, key in enumerate(('credits_c', 'charged_c', 'refunded_c')):
            totals[index] += row[key]
        if row['window_id'] in valid:
            if row['refunded_c'] > 0:
                refunds.setdefault(row['workspace_id'], []).append(row)
    data['duplicate_windows'] = [ids for ids in row_windows.values() if len(ids) > 1]
    data['net_index'] = {}
    for key, pairs in groups.items():
        pairs.sort()
        prefix = [0]
        for _, cents in pairs:
            prefix.append(prefix[-1] + cents)
        data['net_index'][key] = ([at for at, _ in pairs], prefix)
    data['refund_rows'] = refunds
    data['daily_totals'] = daily_totals


def _proof_windows(windows, checks):
    return {w['id'] for w in windows if w['snapshot_version'] and w['success_complete'] and w['contract_version'] == 1
            and w['start_ms'] >= FIRST_COMPLETE_DAY and w['end_ms'] == w['start_ms'] + DAY_MS
            and w['actual_start_ms'] == w['start_ms'] and w['actual_end_ms'] is not None
            and w['start_ms'] < w['actual_end_ms'] <= w['end_ms']
            and not any(c['state'] in ('mismatch', 'duplicate') and c['start_ms'] < w['end_ms']
                        and c['end_ms'] > w['start_ms'] for c in checks)}


def daily_usage(data, day, at):
    selected, reason = usage_days(data['windows'], day, day + DAY_MS, at)
    # Daily API reporting keeps phase 2's short-tail rule; residuals never borrow it.
    _, strict_reason = coverage(data, day, min(day + DAY_MS, at))
    if strict_reason not in (None, 'unfinished_day'):
        reason = strict_reason
    ids = {w['id'] for w in selected}
    if 'daily_totals' in data:
        totals = [sum(data['daily_totals'].get((wid, data['workspace_id']), [0, 0, 0])[i] for wid in ids)
                  for i in range(3)]
    else:
        rows = [r for r in data['rows'] if r['window_id'] in ids and r['workspace_id'] == data['workspace_id']]
        totals = [sum(r[key] for r in rows) for key in ('credits_c', 'charged_c', 'refunded_c')]
    window = next((w for w in data['windows'] if w['start_ms'] == day and w['snapshot_version']), None)
    actual_end = window['actual_end_ms'] if window else None
    complete = reason is None and actual_end is not None and actual_end >= day + DAY_MS
    return dict(day=datetime.fromtimestamp(day / 1000, KST).date().isoformat(),
                actual_start_ms=window['actual_start_ms'] if window else None, actual_end_ms=actual_end,
                **{key: None if reason else totals[i] for i, key in enumerate(('net_c', 'charged_c', 'refunded_c'))},
                complete=complete, collected_at_ms=window['succeeded_at_ms'] if window else None,
                window_versions=[dict(window_id=w['id'], snapshot_version=w['snapshot_version']) for w in selected],
                reason_codes=[reason] if reason else [] if complete else ['partial_day'])


def classify(item, data, topups, revision, allocation_pairs=()):
    if item['state'] != 'residual_present':
        return
    residual, tolerance = item['residual_c'], item['tolerance_c']
    candidates = []
    for peer in allocation_pairs:
        candidates.append(('allocation_candidate', dict(code='opposite_observed_intervals', **peer)))
    matching_days = []
    for topup in topups:
        day = int(datetime.combine(date.fromisoformat(topup['day']), datetime.min.time(), KST).timestamp() * 1000)
        if day < item['end_ms'] and day + DAY_MS > item['start_ms']:
            matching_days.append(topup)
        if (residual > 0 and day < item['end_ms'] and day + DAY_MS > item['start_ms']
                and abs(topup['credits'] * 100 - residual) <= tolerance):
            candidates.append(('topup_candidate', dict(code='current_plan_match', topup_id=topup['id'], plan_revision=revision,
                                                      credits_c=amount(topup['credits'])[0])))
    if residual > 0 and len(matching_days) > 1 and abs(sum(t['credits'] * 100 for t in matching_days) - residual) <= tolerance:
        candidates.append(('topup_candidate', dict(code='current_plan_match', topup_ids=[t['id'] for t in matching_days[:10]],
                                                  topup_count=len(matching_days), plan_revision=revision,
                                                  credits_c=sum(amount(t['credits'])[0] for t in matching_days))))
    refund_rows = data.get('refund_rows', {}).get(data['workspace_id'], []) if 'refund_rows' in data else data['rows']
    for row in refund_rows:
        if (residual > 0 and row['workspace_id'] == data['workspace_id'] and row['created_at'] < item['end_ms']
                and row['refunded_c'] > 0 and abs(row['refunded_c'] - residual) <= tolerance):
            candidates.append(('refund_candidate', dict(code='refund_time_unknown', refunded_c=row['refunded_c'])))
    item['candidate_evidence'] = [dict(candidate=kind, **evidence) for kind, evidence in candidates[:3]]
    item['candidate_count'] = len(candidates)
    if len(candidates) > 3:
        item['reason_codes'].append('candidate_evidence_truncated')
    ambiguous_pair = any(evidence.get('ambiguous_pair') for _, evidence in candidates)
    if len(candidates) == 1 and not ambiguous_pair:
        item['candidate_classification'] = candidates[0][0]
    elif candidates:
        item['reason_codes'].append('multiple_candidates')


def _signature(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()).hexdigest()


def _delivered_version(conn, workspace, start, through, at=None):
    # Only already delivered target intervals can be invalidated by a late arrival.
    cutoff = ' AND received_at_ms<=?' if at is not None else ''
    params = (workspace, start, at) if at is not None else (workspace, start)
    anchor = conn.execute("SELECT MAX(observed_at_ms) FROM hf_balance_obs WHERE workspace_id=? "
                          "AND time_quality='reported' AND observed_at_ms<?" + cutoff, params).fetchone()[0]
    params = (workspace, anchor if anchor is not None else start, through)
    if at is not None:
        params += (at,)
    version = tuple(conn.execute('SELECT COUNT(*),MAX(observation_id) FROM hf_balance_obs '
                                 "WHERE workspace_id=? AND time_quality='reported' AND observed_at_ms>=? "
                                 'AND observed_at_ms<=?' + cutoff, params).fetchone())
    return _signature([anchor, *version])


def _endpoints(conn, workspace, start, end, after, limit, at):
    # One representative per epoch; conflicting cents invalidate both adjacent intervals.
    rows = conn.execute("SELECT observed_at_ms, MIN(observation_id) AS id FROM hf_balance_obs "
                        "WHERE workspace_id=? AND time_quality='reported' AND observed_at_ms>=? AND observed_at_ms<? "
                        'AND observed_at_ms>? AND received_at_ms<=? GROUP BY observed_at_ms ORDER BY observed_at_ms LIMIT ?',
                        (workspace, start, end, after, at, limit)).fetchall()
    points = []
    for row in rows:
        point = dict(conn.execute('SELECT * FROM hf_balance_obs WHERE observation_id=?', (row['id'],)).fetchone())
        point['conflict'] = bool(conn.execute("SELECT 1 FROM hf_balance_obs WHERE workspace_id=? AND time_quality='reported' "
                                             'AND observed_at_ms=? AND credits_c<>? AND received_at_ms<=? LIMIT 1',
                                             (workspace, point['observed_at_ms'], point['credits_c'], at)).fetchone())
        points.append(point)
    return points


def _peer_pairs(conn, first, last, item, data, tiers, *, mutual=True):
    if item['state'] != 'residual_present' or first['collector_id'] != last['collector_id']:
        return []
    # Same two actual collections and opposite main/sub movement; similarity alone is not proof.
    spaces = list(tiers)
    if not spaces:
        return []
    peers = conn.execute('SELECT b.* FROM hf_balance_obs a JOIN hf_balance_obs b ON a.workspace_id=b.workspace_id '
                         "WHERE a.collection_id=? AND b.collection_id=? AND a.collector_id=? AND b.collector_id=? "
                         f"AND b.workspace_id IN ({','.join('?' for _ in spaces)}) "
                         "AND a.observed_at_ms=? AND b.observed_at_ms=? "
                         'AND a.received_at_ms<=? AND b.received_at_ms<=? '
                         "AND a.workspace_id<>? AND a.time_quality='reported' AND b.time_quality='reported'",
                         (first['collection_id'], last['collection_id'], first['collector_id'], last['collector_id'],
                          *spaces, first['observed_at_ms'], last['observed_at_ms'], data['as_of_ms'], data['as_of_ms'],
                          data['workspace_id'])).fetchall()
    pairs = []
    for raw in peers:
        peer = dict(raw)
        if {tiers.get(peer['workspace_id']), tiers.get(data['workspace_id'])} != {'main', 'sub'}:
            continue
        opening = conn.execute('SELECT * FROM hf_balance_obs WHERE workspace_id=? AND observed_at_ms=? AND collection_id=? AND collector_id=? '
                               "AND time_quality='reported' AND received_at_ms<=?",
                               (peer['workspace_id'], first['observed_at_ms'], first['collection_id'], first['collector_id'], data['as_of_ms'])).fetchone()
        # Latest-by-epoch check also rejects ambiguous independent reports at either endpoint.
        points = _endpoints(conn, peer['workspace_id'], opening['observed_at_ms'], peer['observed_at_ms'] + 1,
                            opening['observed_at_ms'] - 1, 2, data['as_of_ms'])
        if len(points) != 2 or points[-1]['observed_at_ms'] != peer['observed_at_ms']:
            continue
        peer_data = dict(data, workspace_id=peer['workspace_id'], workspace_proven=peer['workspace_id'] in data['proven_workspaces'])
        other = interval(peer_data, *points, peer['workspace_id'])
        if (other['state'] == 'residual_present' and item['residual_c'] * other['residual_c'] < 0
                and abs(item['residual_c'] + other['residual_c']) <= item['tolerance_c'] + other['tolerance_c']):
            ambiguous = mutual and len(_peer_pairs(conn, *points, other, peer_data, tiers, mutual=False)) != 1
            pairs.append(dict(workspace_id=peer['workspace_id'], from_observation_id=points[0]['observation_id'],
                              to_observation_id=points[1]['observation_id'], ambiguous_pair=bool(ambiguous), residual_c=other['residual_c']))
    return pairs


def daily_balances(conn, workspace, start, end, at):
    # Counts use original rows, never the downsampled chart or a page of intervals.
    counts = {row['day']: row for row in conn.execute(
        "SELECT (observed_at_ms+32400000)/86400000 AS day,COUNT(*) AS count, "
        "SUM(time_quality<>'reported') AS uncertain FROM hf_balance_obs "
        'WHERE workspace_id=? AND observed_at_ms>=? AND observed_at_ms<? AND received_at_ms<=? GROUP BY day',
        (workspace, start, end, at))}
    edges = {row['day']: row for row in conn.execute(
        'WITH epochs AS (SELECT (observed_at_ms+32400000)/86400000 AS day,observed_at_ms, '
        'CASE WHEN MIN(credits_c)=MAX(credits_c) THEN MIN(credits_c) END AS credits_c '
        "FROM hf_balance_obs WHERE workspace_id=? AND time_quality='reported' "
        'AND observed_at_ms>=? AND observed_at_ms<? AND received_at_ms<=? GROUP BY observed_at_ms), '
        'ranked AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY day ORDER BY observed_at_ms) AS first, '
        'ROW_NUMBER() OVER(PARTITION BY day ORDER BY observed_at_ms DESC) AS last FROM epochs) '
        'SELECT day,MAX(CASE WHEN first=1 THEN credits_c END) AS opening_c, '
        'MAX(CASE WHEN last=1 THEN credits_c END) AS closing_c FROM ranked GROUP BY day',
        (workspace, start, end, at))}
    result = []
    for day in range(start, min(end, at), DAY_MS):
        key = (day + 32400000) // DAY_MS
        count, edge = counts.get(key), edges.get(key)
        opening, closing = (edge['opening_c'], edge['closing_c']) if edge else (None, None)
        result.append(dict(day=datetime.fromtimestamp(day / 1000, KST).date().isoformat(),
                           observation_count=count['count'] if count else 0,
                           time_uncertain_count=count['uncertain'] if count else 0,
                           opening_c=opening, closing_c=closing,
                           delta_c=None if opening is None or closing is None else closing-opening))
    return result


def ledger(workspace_id, start=None, end=None, *, limit=100, cursor=None, at=None):
    at = int(time.time() * 1000) if at is None else at
    start, end = period(start, end, at=at)
    if type(limit) is not int or not 1 <= limit <= 500:
        raise ValueError('row_limit')
    after, expected, delivered_version = start - 1, None, None
    if cursor:
        try:
            if len(cursor) > 2048:
                raise ValueError
            payload = json.loads(base64.urlsafe_b64decode(cursor))
            if payload['scope'] != [workspace_id, start, end] or type(payload['after']) is not int:
                raise ValueError
            after, expected = payload['after'], payload['signature']
            delivered_version = payload['observation_signature']
            if type(payload['as_of_ms']) is not int or not 0 < payload['as_of_ms'] <= at:
                raise ValueError
            at = payload['as_of_ms']
            if not start <= after < end:
                raise ValueError
        except (ValueError, KeyError, TypeError) as exc:
            raise ValueError('invalid_cursor') from exc
    with db.get_connection() as conn:
        conn.execute('BEGIN')
        if error := db_hf_balance.schema_error(conn):
            raise RuntimeError(error)
        daily_balance_rows = daily_balances(conn, workspace_id, start, end, at)
        if cursor and delivered_version != _delivered_version(conn, workspace_id, start, after):
            raise AnalysisChanged('analysis_changed')
        preceding = conn.execute("SELECT MAX(observed_at_ms) FROM hf_balance_obs WHERE workspace_id=? "
                                 "AND time_quality='reported' AND observed_at_ms<? AND received_at_ms<=?", (workspace_id, start, at)).fetchone()[0]
        analysis_start = max(start - 31 * DAY_MS, preceding if preceding is not None else start)
        points = _endpoints(conn, workspace_id, start, end, after, limit + 1, at)
        prior_at = conn.execute("SELECT MAX(observed_at_ms) FROM hf_balance_obs WHERE workspace_id=? "
                                "AND time_quality='reported' AND observed_at_ms<? AND received_at_ms<=?",
                                (workspace_id, points[0]['observed_at_ms'] if points else start, at)).fetchone()[0]
        prior = _endpoints(conn, workspace_id, prior_at, prior_at + 1, prior_at - 1, 1, at)[0] if prior_at is not None else None
        topups = [dict(r) for r in conn.execute('SELECT id,day,credits FROM workspace_credit_topup WHERE workspace_id=? AND day>=? AND day<? ORDER BY day,id',
                  (workspace_id, datetime.fromtimestamp(analysis_start / 1000, KST).date().isoformat(), datetime.fromtimestamp(end / 1000, KST).date().isoformat()))]
        plan = conn.execute('SELECT revision FROM workspace_credit_plan WHERE workspace_id=?', (workspace_id,)).fetchone()
        revision = plan[0] if plan else 0
        tiers = {r[0]: r[1] for r in conn.execute('SELECT workspace_id,tier FROM workspace_console WHERE archived=0')}
        peers = [wid for wid, tier in tiers.items() if tier in ('main', 'sub')]
        related = {workspace_id}
        if peers:
            related.update(r[0] for r in conn.execute(
                'SELECT DISTINCT p.workspace_id FROM hf_balance_obs t '
                'JOIN hf_balance_obs p INDEXED BY idx_hf_balance_obs_history '
                'ON p.collection_id=t.collection_id AND p.collector_id=t.collector_id AND p.observed_at_ms=t.observed_at_ms '
                "WHERE t.workspace_id=? AND t.time_quality='reported' AND p.time_quality='reported' "
                f"AND p.workspace_id IN ({','.join('?' for _ in peers)}) "
                'AND t.observed_at_ms>=? AND t.observed_at_ms<? AND t.received_at_ms<=? AND p.received_at_ms<=?',
                (workspace_id, *peers, preceding if preceding is not None else start, end, at, at)))
        tiers = {wid: tier for wid, tier in tiers.items() if wid in related}
        chart = [dict(r) for r in conn.execute('WITH ranked AS (SELECT observation_id,observed_at_ms,credits_c,time_quality AS quality, '
                 'ROW_NUMBER() OVER (PARTITION BY (observed_at_ms-?)*500/? ORDER BY credits_c,observation_id) AS lo, '
                 'ROW_NUMBER() OVER (PARTITION BY (observed_at_ms-?)*500/? ORDER BY credits_c DESC,observation_id DESC) AS hi '
                 'FROM hf_balance_obs WHERE workspace_id=? AND observed_at_ms>=? AND observed_at_ms<? AND received_at_ms<=?) '
                 'SELECT observation_id,observed_at_ms,credits_c,quality FROM ranked WHERE lo=1 OR hi=1 ORDER BY observed_at_ms,observation_id LIMIT 1000',
                 (start, end-start, start, end-start, workspace_id, start, end, at))]
        for point in chart:
            if point['quality'] == 'reported' and conn.execute("SELECT 1 FROM hf_balance_obs WHERE workspace_id=? "
                    "AND time_quality='reported' AND observed_at_ms=? AND credits_c<>? AND received_at_ms<=? LIMIT 1",
                    (workspace_id, point['observed_at_ms'], point['credits_c'], at)).fetchone():
                point['quality'] = 'conflict'
        # Two missed ten-minute collections mark a gap; downsampling must not invent gaps.
        chart_gaps = [dict(r) for r in conn.execute(
            'WITH epochs AS (SELECT observed_at_ms FROM hf_balance_obs WHERE workspace_id=? '
            "AND time_quality='reported' AND observed_at_ms>=? AND observed_at_ms<? AND received_at_ms<=? "
            'GROUP BY observed_at_ms), pairs AS (SELECT observed_at_ms AS end_ms, '
            'LAG(observed_at_ms) OVER(ORDER BY observed_at_ms) AS start_ms FROM epochs) '
            'SELECT start_ms,end_ms FROM pairs WHERE end_ms-start_ms>1200000 ORDER BY start_ms',
            (workspace_id, start, end, at))]
        content_at = int(time.time() * 1000)
        with manage_db.get_connection() as manage:
            manage.execute('BEGIN')
            cfg = dict(manage.execute('SELECT * FROM hf_org_usage_config WHERE singleton=1').fetchone())
            windows = [dict(r) for r in manage.execute("SELECT * FROM hf_org_usage_window WHERE org_id=? AND kind='day' AND start_ms>=? AND start_ms<? ORDER BY start_ms,id",
                       (cfg['org_id'], today_start(analysis_start), end))]
            rows = []
            spaces = sorted(related)
            for offset in range(0, len(spaces), 500):
                batch = spaces[offset:offset + 500]
                rows.extend(dict(r) for r in manage.execute(
                    'SELECT r.window_id,r.row_id,r.workspace_id,r.created_at,r.credits_c,r.charged_c,r.refunded_c '
                    "FROM hf_org_usage_row r JOIN hf_org_usage_window w ON w.id=r.window_id WHERE w.org_id=? AND w.kind='day' "
                    f"AND w.start_ms>=? AND w.start_ms<? AND r.workspace_id IN ({','.join('?' for _ in batch)}) ORDER BY w.id,r.row_id",
                    (cfg['org_id'], today_start(analysis_start), end, *batch)))
            checks = [dict(r) for r in manage.execute('SELECT * FROM hf_org_usage_check WHERE org_id=? AND start_ms<? AND end_ms>? ORDER BY start_ms,end_ms',
                      (cfg['org_id'], end, analysis_start))]
            manage_at = int(time.time() * 1000)
        valid_ids = _proof_windows(windows, checks)
        proven = {r['workspace_id'] for r in rows if r['window_id'] in valid_ids}
        data = dict(config=cfg, windows=windows, rows=rows, checks=checks, workspace_id=workspace_id, as_of_ms=at,
                    workspace_proven=workspace_id in proven, proven_workspaces=proven)
        _prepare(data)
        window_inputs = [{key:w[key] for key in ('id','start_ms','end_ms','contract_version','snapshot_version','row_count','success_complete',
                                                'actual_start_ms','actual_end_ms','succeeded_at_ms')} for w in windows]
        check_inputs = [{key:value for key,value in check.items() if key != 'checked_at_ms'} for check in checks]
        signature = _signature([workspace_id, start, end, at, window_inputs, check_inputs, cfg['org_id'], cfg['revision'], cfg['enabled'],
                                cfg['restore_paused'], revision, topups, tiers])
        if expected and expected != signature:
            raise AnalysisChanged('analysis_changed')
        has_more = len(points) > limit
        points = points[:limit]
        observation_signature = _delivered_version(conn, workspace_id, start, points[-1]['observed_at_ms'], at) if has_more else None
        intervals = []
        for point in points:
            if prior:
                item = interval(data, prior, point, workspace_id)
                classify(item, data, topups, revision, _peer_pairs(conn, prior, point, item, data, tiers))
                intervals.append(item)
            prior = point
    daily = [daily_usage(data, day, at) for day in range(start, min(end, at), DAY_MS)]
    token = base64.urlsafe_b64encode(json.dumps(dict(scope=[workspace_id, start, end], as_of_ms=at,
                                                   after=points[-1]['observed_at_ms'], signature=signature,
                                                   observation_signature=observation_signature)).encode()).decode() if has_more else None
    reasons = sorted({reason for i in intervals for reason in i['reason_codes']} | {reason for d in daily for reason in d['reason_codes']})
    _, api_reason = coverage(data, start, min(end, at)) if start < at else ([], 'future_period')
    if api_reason:
        reasons = sorted(set(reasons) | {api_reason})
    return dict(balance_protocol=1, workspace_id=workspace_id, timezone='Asia/Seoul', requested_start_ms=start, requested_end_ms=end,
                as_of_ms=at, content_read_at_ms=content_at, manage_read_at_ms=manage_at, basis_signature=signature,
                api_state='unavailable' if api_reason else 'available', reason_codes=reasons,
                api_window_versions=[dict(window_id=w['id'], snapshot_version=w['snapshot_version']) for w in windows],
                plan_revision=revision, chart_points=chart, chart_gaps=chart_gaps, intervals=intervals,
                daily_api=daily, daily_balances=daily_balance_rows,
                returned_count=len(intervals), has_more=has_more, next_cursor=token)
