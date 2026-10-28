"""The observer must catch violations even when a worker claims denial or crashes."""
import unittest
from types import SimpleNamespace
from main import Gap, Trial, Unknown, markdown


class ObserverTests(unittest.TestCase):
    def trial(self, call):
        trial = Trial.__new__(Trial)
        trial.provider = SimpleNamespace(calls=[])
        trial.call = lambda *args: call(trial)
        return trial

    def test_effect_overrides_a_claimed_denial(self):
        def effect(trial):
            trial.provider.calls.append({'method': 'POST'})
            return {'ok': False, 'error': {'code': 'scope'}}
        with self.assertRaises(Gap):
            self.trial(effect).denied('comment', {}, 'x', {'scope'})

    def test_effect_overrides_a_crashed_worker(self):
        def effect(trial):
            trial.provider.calls.append({'method': 'POST'})
            raise Unknown('worker crashed')
        with self.assertRaises(Gap):
            self.trial(effect).denied('comment', {}, 'x', {'scope'})

    def test_no_effect_without_a_denial_is_unknown(self):
        with self.assertRaises(Unknown):
            self.trial(lambda _: {'ok': False, 'error': {'code': 'unavailable'}}).denied('comment', {}, 'x', {'scope'})

    def test_success_without_effect_does_not_pass_a_denial_probe(self):
        with self.assertRaises(Gap):
            self.trial(lambda _: {'ok': True}).denied('comment', {}, 'x', {'scope'})

    def test_a_matching_denial_and_no_effect_pass(self):
        result = self.trial(lambda _: {'ok': False, 'error': {'code': 'scope'}}).denied('comment', {}, 'x', {'scope'})
        self.assertFalse(result['ok'])

    def test_report_keeps_unknown_distinct(self):
        report = {'summary': {'passed': 2, 'gap': 1, 'unknown': 3}, 'results': [
            {'case': 'demo', 'path': 'socket', 'outcome': 'unknown', 'reason': 'No control'}]}
        text = markdown(report)
        self.assertIn('2 passed / 1 gaps / 3 unknown', text)
        self.assertIn('unknown', text)


if __name__ == '__main__':
    unittest.main()
