import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('permissions', Path(__file__).parents[1] / 'scripts/check_permissions.py')
permissions = importlib.util.module_from_spec(spec)
spec.loader.exec_module(permissions)


class PermissionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.repo = Path(self.directory.name) / 'repository.json'
        self.user = Path(self.directory.name) / 'user.json'
        self.write(self.repo, ['Bash(git push --force*)'], ['Bash(drop*)'])

    def write(self, path, deny, ask):
        path.write_text(json.dumps({'permissions': {'deny': deny, 'ask': ask}}))

    def test_extra_user_restrictions_are_allowed(self):
        self.write(self.user, ['Bash(git push --force*)', 'Bash(other*)'], ['Bash(drop*)'])
        self.assertIsNone(permissions.check_permissions(self.repo, self.user))

    def test_missing_user_rule_fails(self):
        self.write(self.user, [], ['Bash(drop*)'])
        self.assertIsNotNone(permissions.check_permissions(self.repo, self.user))
        self.write(self.user, ['Bash(git push --force*)'], [])
        self.assertIsNotNone(permissions.check_permissions(self.repo, self.user))

    def test_invalid_user_configuration_fails(self):
        self.user.write_text('{invalid')
        self.assertEqual(permissions.check_permissions(self.repo, self.user), 'User permission configuration is invalid.')

    def test_invalid_repository_configuration_fails(self):
        self.repo.write_text('{"permissions":{"deny":"not a list"}}')
        self.assertEqual(permissions.check_permissions(self.repo, self.user), 'Repository permission configuration is missing or invalid.')

    def test_missing_user_file_uses_repository_restrictions(self):
        self.assertIsNone(permissions.check_permissions(self.repo, self.user))

    def test_missing_repository_file_fails(self):
        self.repo = self.repo.with_name('missing.json')
        self.assertEqual(permissions.check_permissions(self.repo, self.user), 'Repository permission configuration is missing or invalid.')
