import math
import pytest
from app.hf_balance_contract import amount, normalize, validate_batch
from hf_balance_fixtures import observation


@pytest.mark.parametrize('value', [None, True, False, 'NaN', 'Infinity', '', {}, [], 90071992547410])
def test_amount_validation_missing_null_zero_and_limits(value):
    with pytest.raises(ValueError):
        amount(value)
    assert amount(0)[0] == 0
    assert amount('-1.005')[0] == -101


def test_decimal_normalization_and_binary32_boundary():
    assert amount('65536.0078125') == (6553601, 'workspace_list_binary32', 0)
    assert amount('131072.015625') == (13107202, 'workspace_list_binary32', 1)
    assert amount('205722.765625') == (20572277, 'workspace_list_binary32', 1)
    assert amount('90071992547409.91')[0] == 9007199254740991
    with pytest.raises(ValueError):
        normalize(observation(credits_c=True))


@pytest.mark.parametrize('value,error', [('131072',1),('262144',2),('524288',3),
                                        ('1048576',6),('-524288',3),('205722.76',None)])
def test_binary32_error_bound_by_magnitude(value, error):
    assert amount(value)[2] == error


def test_observation_count_limit():
    validate_batch(1, [observation()]*100)
    for version, items in [(True, []),(2, []),(1, [observation()]*101),(1, None)]:
        with pytest.raises(ValueError):
            validate_batch(version, items)


def test_account_status_is_not_a_workspace_observation():
    with pytest.raises(ValueError, match='source'):
        normalize(observation(source='account_status'))
