"""Keep repository permission restrictions within the user's restrictions."""
import json
from pathlib import Path


def permission_blocks(path):
    value = json.loads(path.read_text())
    if not isinstance(value, dict) or not isinstance(value.get('permissions'), dict):
        raise ValueError('Missing permissions object')
    permissions = value['permissions']
    result = []
    for name in ('deny', 'ask'):
        items = permissions.get(name, [])
        if not isinstance(items, list) or any(not isinstance(item, str) for item in items):
            raise ValueError('Invalid permission list')
        result.append(set(items))
    return result


def check_permissions(repository, user):
    try:
        tracked = permission_blocks(repository)
    except (OSError, ValueError, TypeError):
        return 'Repository permission configuration is missing or invalid.'
    if not user.exists():
        return None
    try:
        personal = permission_blocks(user)
    except (OSError, ValueError, TypeError):
        return 'User permission configuration is invalid.'
    if any(not required <= available for required, available in zip(tracked, personal)):
        return 'Repository deny/ask restrictions differ from user restrictions.'
    return None


if __name__ == '__main__':
    error = check_permissions(Path('.claude/settings.json'), Path.home() / '.claude/settings.json')
    if error:
        raise SystemExit(error)
    print('Permission restrictions match.')
