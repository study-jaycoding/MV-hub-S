"""Read-only analysis of immutable observations against current API/plan inputs."""
from __future__ import annotations

import base64
import hashlib
import json
import time
from bisect import bisect_left
from datetime import date, datetime, timedelta, timezone

from .. import db, manage_db
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
    groups, row_windows, refunds = {}, {}, {}
    valid = _proof_windows(data['windows'], data['checks'])
    for row in data['rows']:
        groups.setdefault((row['window_id'], row['workspace_id']), []).append((row['created_at'], row['credits_c']))
        row_windows.setdefault(row['row_id'], set()).add(row['window_id'])
        if row['window_id'] in valid:
            refunds.setdefault(row['workspace_id'], []).append((row['created_at'], row['refunded_c']))
    data['duplicate_windows'] = [ids for ids in row_windows.values() if len(ids) > 1]
    data['net_index'] = {}
    for key, pairs in groups.items():
        pairs.sort()
        prefix = [0]
        for _, cents in pairs:
            prefix.append(prefix[-1] + cents)
        data['net_index'][key] = ([at for at, _ in pairs], prefix)
    data['refund_index'] = {}
    for workspace, pairs in refunds.items():
        pairs.sort()
        prefix = [0]
        for _, cents in pairs:
            prefix.append(prefix[-1] + cents)
        data['refund_index'][workspace] = ([at for at, _ in pairs], prefix)


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
    rows = [r for r in data['rows'] if r['window_id'] in ids and r['workspace_id'] == data['workspace_id']]
    window = next((w for w in data['windows'] if w['start_ms'] == day and w['snapshot_version']), None)
    actual_end = window['actual_end_ms'] if window else None
    complete = reason is None and actual_end is not None and actual_end >= day + DAY_MS
    return dict(day=datetime.fromtimestamp(day / 1000, KST).date().isoformat(),
                actual_start_ms=window['actual_start_ms'] if window else None, actual_end_ms=actual_end,
                **{key: None if reason else sum(r[field] for r in rows) for key, field in
                   (('net_c', 'credits_c'), ('charged_c', 'charged_c'), ('refunded_c', 'refunded_c'))},
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
            candidates.append(('topup_candidate', dict(code='current_plan_match', topup_id=topup['id'], plan_revision=revision)))
    if residual > 0 and len(matching_days) > 1 and abs(sum(t['credits'] * 100 for t in matching_days) - residual) <= tolerance:
        candidates.append(('topup_candidate', dict(code='current_plan_match', topup_ids=[t['id'] for t in matching_days[:10]],
                                                  topup_count=len(matching_days), plan_revision=revision)))
    if 'refund_index' in data:
        times, prefix = data['refund_index'].get(data['workspace_id'], ([], [0]))
        refunds = prefix[bisect_left(times, item['end_ms'])]
    else:
        refunds = sum(r['refunded_c'] for r in data['rows'] if r['workspace_id'] == data['workspace_id']
                      and r['created_at'] < item['end_ms'])
    if residual > 0 and refunds > 0 and abs(refunds - residual) <= tolerance:
        candidates.append(('refund_candidate', dict(code='refund_time_unknown', refunded_c=refunds)))
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


def _endpoints(conn, workspace, start, end, after, limit):
    # One representative per epoch; conflicting cents invalidate both adjacent intervals.
    rows = conn.execute("SELECT observed_at_ms, MIN(observation_id) AS id FROM hf_balance_obs "
                        "WHERE workspace_id=? AND time_quality='reported' AND observed_at_ms>=? AND observed_at_ms<? "
                        'AND observed_at_ms>? GROUP BY observed_at_ms ORDER BY observed_at_ms LIMIT ?',
                        (workspace, start, end, after, limit)).fetchall()
    points = []
    for row in rows:
        point = dict(conn.execute('SELECT * FROM hf_balance_obs WHERE observation_id=?', (row['id'],)).fetchone())
        point['conflict'] = bool(conn.execute("SELECT 1 FROM hf_balance_obs WHERE workspace_id=? AND time_quality='reported' "
                                             'AND observed_at_ms=? AND credits_c<>? LIMIT 1',
                                             (workspace, point['observed_at_ms'], point['credits_c'])).fetchone())
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
                         "AND a.workspace_id<>? AND a.time_quality='reported' AND b.time_quality='reported'",
                         (first['collection_id'], last['collection_id'], first['collector_id'], last['collector_id'],
                          *spaces, first['observed_at_ms'], last['observed_at_ms'], data['workspace_id'])).fetchall()
    pairs = []
    for raw in peers:
        peer = dict(raw)
        if {tiers.get(peer['workspace_id']), tiers.get(data['workspace_id'])} != {'main', 'sub'}:
            continue
        opening = conn.execute('SELECT * FROM hf_balance_obs WHERE workspace_id=? AND observed_at_ms=? AND collection_id=? AND collector_id=?',
                               (peer['workspace_id'], first['observed_at_ms'], first['collection_id'], first['collector_id'])).fetchone()
        # Latest-by-epoch check also rejects ambiguous independent reports at either endpoint.
        points = _endpoints(conn, peer['workspace_id'], opening['observed_at_ms'], peer['observed_at_ms'] + 1,
                            opening['observed_at_ms'] - 1, 2)
        if len(points) != 2 or points[-1]['observed_at_ms'] != peer['observed_at_ms']:
            continue
        peer_data = dict(data, workspace_id=peer['workspace_id'], workspace_proven=peer['workspace_id'] in data['proven_workspaces'])
        other = interval(peer_data, *points, peer['workspace_id'])
        if (other['state'] == 'residual_present' and item['residual_c'] * other['residual_c'] < 0
                and abs(item['residual_c'] + other['residual_c']) <= item['tolerance_c'] + other['tolerance_c']):
            ambiguous = mutual and len(_peer_pairs(conn, *points, other, peer_data, tiers, mutual=False)) != 1
            pairs.append(dict(workspace_id=peer['workspace_id'], from_observation_id=points[0]['observation_id'],
                              to_observation_id=points[1]['observation_id'], ambiguous_pair=bool(ambiguous)))
    return pairs


def ledger(workspace_id, start=None, end=None, *, limit=100, cursor=None, at=None):
    at = int(time.time() * 1000) if at is None else at
    start, end = period(start, end, at=at)
    if type(limit) is not int or not 1 <= limit <= 500:
        raise ValueError('row_limit')
    after, expected = start - 1, None
    if cursor:
        try:
            if len(cursor) > 2048:
                raise ValueError
            payload = json.loads(base64.urlsafe_b64decode(cursor))
            if payload['scope'] != [workspace_id, start, end] or type(payload['after']) is not int:
                raise ValueError
            after, expected = payload['after'], payload['signature']
            if type(payload['as_of_ms']) is not int or not 0 < payload['as_of_ms'] <= at:
                raise ValueError
            at = payload['as_of_ms']
            if not start <= after < end:
                raise ValueError
        except (ValueError, KeyError, TypeError) as exc:
            raise ValueError('invalid_cursor') from exc
    with db.get_connection() as conn:
        conn.execute('BEGIN')
        preceding = conn.execute("SELECT MAX(observed_at_ms) FROM hf_balance_obs WHERE workspace_id=? "
                                 "AND time_quality='reported' AND observed_at_ms<?", (workspace_id, start)).fetchone()[0]
        analysis_start = max(start - 31 * DAY_MS, preceding if preceding is not None else start)
        points = _endpoints(conn, workspace_id, start, end, after, limit + 1)
        prior_at = conn.execute("SELECT MAX(observed_at_ms) FROM hf_balance_obs WHERE workspace_id=? "
                                "AND time_quality='reported' AND observed_at_ms<?",
                                (workspace_id, points[0]['observed_at_ms'] if points else start)).fetchone()[0]
        prior = _endpoints(conn, workspace_id, prior_at, prior_at + 1, prior_at - 1, 1)[0] if prior_at is not None else None
        topups = [dict(r) for r in conn.execute('SELECT id,day,credits FROM workspace_credit_topup WHERE workspace_id=? AND day>=? AND day<? ORDER BY day,id',
                  (workspace_id, datetime.fromtimestamp(analysis_start / 1000, KST).date().isoformat(), datetime.fromtimestamp(end / 1000, KST).date().isoformat()))]
        plan = conn.execute('SELECT revision FROM workspace_credit_plan WHERE workspace_id=?', (workspace_id,)).fetchone()
        revision = plan[0] if plan else 0
        tiers = {r[0]: r[1] for r in conn.execute('SELECT workspace_id,tier FROM workspace_console WHERE archived=0')}
        content_version = []
        version_spaces = sorted(set(tiers) | {workspace_id})
        for offset in range(0, len(version_spaces), 500):
            spaces = version_spaces[offset:offset + 500]
            content_version.extend(tuple(r) for r in conn.execute('SELECT workspace_id,COUNT(*),MAX(observation_id) FROM hf_balance_obs '
                           f"WHERE workspace_id IN ({','.join('?' for _ in spaces)}) AND observed_at_ms>=? AND observed_at_ms<? "
                           'GROUP BY workspace_id ORDER BY workspace_id', (*spaces, analysis_start, end)))
        anchor_version = [tuple(r) for r in conn.execute('SELECT observation_id,payload_sha256 FROM hf_balance_obs '
                          "WHERE workspace_id=? AND time_quality='reported' AND observed_at_ms=? ORDER BY observation_id", (workspace_id, preceding))]
        chart = [dict(r) for r in conn.execute('WITH ranked AS (SELECT observation_id,observed_at_ms,credits_c,time_quality AS quality, '
                 'ROW_NUMBER() OVER (PARTITION BY (observed_at_ms-?)*500/? ORDER BY credits_c,observation_id) AS lo, '
                 'ROW_NUMBER() OVER (PARTITION BY (observed_at_ms-?)*500/? ORDER BY credits_c DESC,observation_id DESC) AS hi '
                 'FROM hf_balance_obs WHERE workspace_id=? AND observed_at_ms>=? AND observed_at_ms<?) '
                 'SELECT observation_id,observed_at_ms,credits_c,quality FROM ranked WHERE lo=1 OR hi=1 ORDER BY observed_at_ms,observation_id LIMIT 1000',
                 (start, end-start, start, end-start, workspace_id, start, end))]
        for point in chart:
            if point['quality'] == 'reported' and conn.execute("SELECT 1 FROM hf_balance_obs WHERE workspace_id=? "
                    "AND time_quality='reported' AND observed_at_ms=? AND credits_c<>? LIMIT 1",
                    (workspace_id, point['observed_at_ms'], point['credits_c'])).fetchone():
                point['quality'] = 'conflict'
        content_at = int(time.time() * 1000)
        with manage_db.get_connection() as manage:
            manage.execute('BEGIN')
            cfg = dict(manage.execute('SELECT * FROM hf_org_usage_config WHERE singleton=1').fetchone())
            windows = [dict(r) for r in manage.execute("SELECT * FROM hf_org_usage_window WHERE org_id=? AND kind='day' AND start_ms>=? AND start_ms<? ORDER BY start_ms,id",
                       (cfg['org_id'], today_start(analysis_start), end))]
            rows = [dict(r) for r in manage.execute('SELECT r.window_id,r.row_id,r.workspace_id,r.created_at,r.credits_c,r.charged_c,r.refunded_c '
                    "FROM hf_org_usage_row r JOIN hf_org_usage_window w ON w.id=r.window_id WHERE w.org_id=? AND w.kind='day' AND w.start_ms>=? AND w.start_ms<? ORDER BY w.id,r.row_id",
                    (cfg['org_id'], today_start(analysis_start), end))]
            checks = [dict(r) for r in manage.execute('SELECT * FROM hf_org_usage_check WHERE org_id=? AND start_ms<? AND end_ms>? ORDER BY start_ms,end_ms',
                      (cfg['org_id'], end, analysis_start))]
            manage_at = int(time.time() * 1000)
        valid_ids = _proof_windows(windows, checks)
        proven = {r['workspace_id'] for r in rows if r['window_id'] in valid_ids}
        data = dict(config=cfg, windows=windows, rows=rows, checks=checks, workspace_id=workspace_id,
                    workspace_proven=workspace_id in proven, proven_workspaces=proven)
        _prepare(data)
        window_inputs = [{key:w[key] for key in ('id','start_ms','end_ms','contract_version','snapshot_version','success_complete',
                                                'actual_start_ms','actual_end_ms','succeeded_at_ms')} for w in windows]
        signature = _signature([workspace_id, start, end, at, content_version, anchor_version,
                                window_inputs, rows, checks, cfg['revision'], cfg['enabled'], cfg['restore_paused'], revision, topups, tiers])
        if expected and expected != signature:
            raise AnalysisChanged('analysis_changed')
        has_more = len(points) > limit
        points = points[:limit]
        intervals = []
        for point in points:
            if prior:
                item = interval(data, prior, point, workspace_id)
                classify(item, data, topups, revision, _peer_pairs(conn, prior, point, item, data, tiers))
                intervals.append(item)
            prior = point
    daily = [daily_usage(data, day, at) for day in range(start, min(end, at), DAY_MS)]
    token = base64.urlsafe_b64encode(json.dumps(dict(scope=[workspace_id, start, end], as_of_ms=at,
                                                   after=points[-1]['observed_at_ms'], signature=signature)).encode()).decode() if has_more else None
    reasons = sorted({reason for i in intervals for reason in i['reason_codes']} | {reason for d in daily for reason in d['reason_codes']})
    _, api_reason = coverage(data, start, min(end, at)) if start < at else ([], 'future_period')
    if api_reason:
        reasons = sorted(set(reasons) | {api_reason})
    return dict(balance_protocol=1, workspace_id=workspace_id, timezone='Asia/Seoul', requested_start_ms=start, requested_end_ms=end,
                as_of_ms=at, content_read_at_ms=content_at, manage_read_at_ms=manage_at, basis_signature=signature,
                api_state='unavailable' if api_reason else 'available', reason_codes=reasons,
                api_window_versions=[dict(window_id=w['id'], snapshot_version=w['snapshot_version']) for w in windows],
                plan_revision=revision, chart_points=chart, intervals=intervals, daily_api=daily,
                returned_count=len(intervals), has_more=has_more, next_cursor=token)
