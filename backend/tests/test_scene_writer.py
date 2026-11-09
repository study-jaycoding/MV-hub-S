import threading
import pytest
from app import active_account
from app.services.scene_writer import SceneWriter, WriterConflict
from test_scene_notebook import notebook_db


def test_expiry_epoch_and_boot_tokens(notebook_db):
    now = [0.0]
    service = SceneWriter(clock=lambda: now[0])
    token = service.action('u', 'claim', 'browser', 'tab')['token']
    with service.writing('u', token):
        pass
    now[0] = 91
    with pytest.raises(WriterConflict):
        with service.writing('u', token):
            pass
    token = service.action('u', 'claim', 'browser', 'tab')['token']
    active_account.bump_account_epoch()
    with pytest.raises(WriterConflict):
        service.action('u', 'renew', token=token)
    with pytest.raises(WriterConflict):
        SceneWriter().action('u', 'renew', token=token)


def test_force_wait_generation_and_late_release(notebook_db):
    now = [0.0]
    service = SceneWriter(clock=lambda: now[0])
    old = service.action('u', 'claim', 'one', 'tab')['token']
    pending = service.action('u', 'request', 'two', 'tab')['request_id']
    with pytest.raises(WriterConflict, match='handoff_wait'):
        service.action('u', 'force', 'two', 'tab', request_id=pending)
    now[0] = 5
    new = service.action('u', 'force', 'two', 'tab', request_id=pending)['token']
    with pytest.raises(WriterConflict):
        service.action('u', 'release', token=old)
    service.action('u', 'renew', token=new)


def test_claim_and_database_commit_are_one_serial_section(notebook_db):
    service = SceneWriter()
    old = service.action('u', 'claim', 'one', 'tab')['token']
    attempted, finished = threading.Event(), threading.Event()
    outcome = []
    def contender():
        attempted.set()
        try:
            service.action('u', 'claim', 'two', 'tab')
        except WriterConflict:
            outcome.append('blocked')
        finally:
            finished.set()
    with service.writing('u', old):
        worker = threading.Thread(target=contender)
        worker.start()
        assert attempted.wait(1)
        assert not finished.wait(.03)
    worker.join(2)
    assert outcome == ['blocked']


def test_third_browser_cannot_use_previous_handoff_ticket(notebook_db):
    service = SceneWriter(clock=lambda: 100)
    old = service.action('u', 'claim', 'one', 'tab')['token']
    pending = service.action('u', 'request', 'two', 'tab')['request_id']
    service.action('u', 'release', token=old)
    service.action('u', 'claim', 'three', 'tab')
    with pytest.raises(WriterConflict):
        service.action('u', 'force', 'two', 'tab', request_id=pending)
