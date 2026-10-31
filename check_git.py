"""The `git-commit-exists` check: does the student's repository hold a commit?

Git can run programs that a repository's own config names: a file system
monitor, hooks, a pager, an external diff, an editor, an SSH command, and more.
A repository in the student's workspace is not trusted. So this check:

* never uses a shell. Git runs from an argument list, with `cwd` set to the
  workspace.
* gives git a clean environment. No `GIT_*` variable of the server's reaches it.
  System and user config are switched off.
* names the git folder itself with `--git-dir`, after checking it. The `.git`
  entry must be a real folder, or a file that points at a folder inside the
  workspace. A link, or a file that points outside, is refused. Git never walks
  up to a parent repository.
* passes a fixed list of `-c` overrides that switch off every setting known to
  name a program (`FIXED_CONFIG`).
* runs only three read commands: `rev-parse`, `rev-list`, and `cat-file`. None
  of them reads the index or the working tree, and none of them runs hooks.
* limits each run in time and output, and kills git and its children on either.
* checks that the current user owns the repository. When `--git-dir` is given,
  git skips its own ownership check, so this module repeats it. It never passes
  `safe.directory`, so it never widens trust.

`docs/RELEASE.md` lists what was proved by test and what was not.

Only the Python standard library is used.
"""
import os
import re
import shutil
import stat
import subprocess
import tempfile
import threading

import check_runner
import check_workspace
from check_runner import DescriptorError, result, take_fields
from check_workspace import WorkspaceError

# Each pair becomes `-c key=value`. An empty value clears a setting that names a program.
FIXED_CONFIG = (
    ('core.fsmonitor', 'false'),
    ('core.hooksPath', os.devnull),
    ('core.sshCommand', ''),
    ('core.pager', 'cat'),
    ('core.editor', ''),
    ('core.askPass', ''),
    ('core.alternateRefsCommand', ''),
    ('core.attributesFile', os.devnull),
    ('core.excludesFile', os.devnull),
    ('diff.external', ''),
    ('credential.helper', ''),
    ('gpg.program', 'false'),
    ('uploadpack.packObjectsHook', ''),
    ('gc.auto', '0'),
    ('maintenance.auto', 'false'),
)
SAFE_PATH = '/usr/bin:/bin'
PRIVATE_PREFIX = 'schola-git-'
MAX_GITFILE_BYTES = 4096
MAX_STDERR_BYTES = 4096
_SHA = re.compile(r'^[0-9a-f]{40}(?:[0-9a-f]{24})?$')
_BATCH_HEADER = re.compile(rb'^([0-9a-f]{40}(?:[0-9a-f]{24})?) (\w+) (\d+)$')

# Entries of the git folder that must be plain files or plain folders, never links, pipes, or sockets.
_FILES = ('HEAD', 'config', 'packed-refs', 'shallow', 'description')
_FOLDERS = ('objects', 'refs', 'info')
_REFUSED = ('commondir', 'objects/info/alternates', 'objects/info/http-alternates')


class GitProblem(Exception):
    """A result the check reports. `status` is `failed`, `error`, or `skipped`."""

    def __init__(self, status, reason, message):
        super().__init__(message)
        self.status, self.reason, self.message = status, reason, message

    def as_result(self, **evidence):
        return result(self.status, {'reason': self.reason, **evidence}, [self.message])


def find_git():
    """The path of the git program, or None."""
    return shutil.which('git')


def _unsafe(message='This folder has a .git entry that Schola will not use. It is a link, points outside the workspace, or is not a normal git folder.'):
    return GitProblem('error', 'unsafe_git_dir', message)


# ---------------------------------------------------------------------------
# Finding and checking the git folder
# ---------------------------------------------------------------------------

def _owned(info):
    return not hasattr(os, 'geteuid') or info.st_uid == os.geteuid()


def locate_git_dir(root):
    """The real path of the git folder of the workspace `root`, or a GitProblem."""
    entry = os.path.join(root, '.git')
    try:
        info = os.lstat(entry)
    except FileNotFoundError:
        raise GitProblem('failed', 'no_repository', 'This folder is not a git repository. Run git init here, then make a commit.') from None
    except OSError:
        raise _unsafe() from None
    if stat.S_ISLNK(info.st_mode):
        raise _unsafe()
    if stat.S_ISDIR(info.st_mode):
        gitdir = entry
    elif stat.S_ISREG(info.st_mode):
        gitdir = _follow_gitfile(root)
    else:
        raise _unsafe()
    return _validate_git_dir(root, gitdir)


def _follow_gitfile(root):
    try:
        data = check_workspace.read_file(root, '.git', MAX_GITFILE_BYTES)
    except WorkspaceError:
        raise _unsafe() from None
    try:
        text = data.decode('utf-8')
    except UnicodeError:
        raise _unsafe() from None
    first = text.split('\n', 1)[0].rstrip('\r')
    if not first.startswith('gitdir: ') or '\x00' in text:
        raise _unsafe()
    target = first[len('gitdir: '):].strip()
    if not target or any(ord(ch) < 32 for ch in target):
        raise _unsafe()
    try:
        real = os.path.realpath(os.path.join(root, target), strict=True)
    except (OSError, ValueError):
        raise _unsafe() from None
    if not check_workspace.is_inside(root, real) or real == root:
        raise _unsafe()
    return real


def _validate_git_dir(root, gitdir):
    """The git folder, as a real path: a real folder inside the workspace, owned by this user, with plain entries."""
    try:
        real = os.path.realpath(gitdir)
        if real == root or not check_workspace.is_inside(root, real):
            raise _unsafe()
        info = os.lstat(real)
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise _unsafe()
        owner_ok = _owned(info) and _owned(os.lstat(root))
    except OSError:
        raise _unsafe() from None
    if not owner_ok:
        raise GitProblem('error', 'untrusted_repository',
                         'Another user owns this repository. Git would not trust it, and neither does Schola. Make a repository of your own in your folder.')
    for name in _REFUSED:
        if os.path.lexists(os.path.join(real, *name.split('/'))):
            raise _unsafe('This repository borrows objects or settings from another folder. Schola will not read it. Make a repository of your own.')
    for name in _FILES:
        _require(real, name, stat.S_ISREG, required=name == 'HEAD')
    for name in _FOLDERS:
        _require(real, name, stat.S_ISDIR, required=name != 'info')
    return real


def _require(gitdir, name, kind, required):
    path = os.path.join(gitdir, name)
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        if required:
            raise _unsafe() from None
        return
    except OSError:
        raise _unsafe() from None
    if stat.S_ISLNK(info.st_mode) or not kind(info.st_mode):
        raise _unsafe()


# ---------------------------------------------------------------------------
# Running git
# ---------------------------------------------------------------------------

def clean_environment(private):
    """The only variables git gets. Nothing is copied from the server's own environment."""
    return {
        'PATH': SAFE_PATH, 'HOME': private, 'XDG_CONFIG_HOME': private, 'LANG': 'C', 'LC_ALL': 'C',
        'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_SYSTEM': os.devnull,
        'GIT_TERMINAL_PROMPT': '0', 'GIT_OPTIONAL_LOCKS': '0', 'GIT_PAGER': 'cat', 'GIT_ATTR_NOSYSTEM': '1', 'GIT_NO_REPLACE_OBJECTS': '1',
    }


def build_command(git, gitdir, verb_and_args):
    command = [git, '--no-pager', '--no-replace-objects', '--git-dir', gitdir]
    for key, value in FIXED_CONFIG:
        command += ['-c', f'{key}={value}']
    return command + list(verb_and_args)


def _drain(stream, keep, box):
    """Read a stream to its end. Keep only the first `keep` bytes, so a flood costs no memory."""
    kept = bytearray()
    try:
        while True:
            chunk = stream.read(65536)
            if not chunk:
                break
            if len(kept) < keep:
                kept += chunk[:keep - len(kept)]
    except (OSError, ValueError):
        pass
    box.append(bytes(kept))


def run_git(git, gitdir, workspace, private, args, limits, input_bytes=None):
    """Run one git read command. Returns (return code, stdout bytes, stderr bytes)."""
    stdin = subprocess.DEVNULL
    stdin_handle = None
    if input_bytes is not None:
        path = os.path.join(private, 'input')
        with open(path, 'wb') as handle:
            handle.write(input_bytes)
        stdin = stdin_handle = open(path, 'rb')
    try:
        process = subprocess.Popen(build_command(git, gitdir, args), cwd=workspace, env=clean_environment(private), shell=False,
                                   stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, close_fds=True)
    except OSError:
        raise GitProblem('skipped', 'git_unavailable', 'Schola cannot start git. Report this check yourself (self-report).') from None
    finally:
        if stdin_handle is not None:
            stdin_handle.close()
    state = {'timed_out': False}
    errors = []
    reader = threading.Thread(target=_drain, args=(process.stderr, MAX_STDERR_BYTES, errors), daemon=True)
    reader.start()

    def expire():
        if process.poll() is None:
            state['timed_out'] = True
            check_runner.kill_group(process)

    timer = threading.Timer(limits.git_timeout, expire)
    timer.daemon = True
    timer.start()
    try:
        out = process.stdout.read(limits.git_output_bytes + 1)
        truncated = len(out) > limits.git_output_bytes
        if truncated:
            check_runner.kill_group(process)
        process.wait()
        reader.join(2)
    finally:
        timer.cancel()
        if process.poll() is None:
            check_runner.kill_group(process)
            process.wait()
        process.stdout.close()
        reader.join(2)
        process.stderr.close()
    if state['timed_out']:
        raise GitProblem('error', 'git_timeout', 'Git took too long, so Schola stopped it.')
    if truncated:
        raise GitProblem('error', 'output_too_large', 'Git printed more than Schola reads for a check.')
    return process.returncode, out, errors[0] if errors else b''


def _remove_private(path):
    """Remove the private folder, but only a folder this module made directly in the temp root."""
    try:
        real = os.path.realpath(path)
        root = os.path.realpath(tempfile.gettempdir())
        if os.path.dirname(real) == root and os.path.basename(real).startswith(PRIVATE_PREFIX) and not os.path.islink(path):
            shutil.rmtree(real, ignore_errors=True)
    except OSError:
        pass


def _parse_batch(data, wanted):
    """The messages of the commits in `cat-file --batch` output. A malformed answer raises ValueError."""
    messages, offset = [], 0
    while offset < len(data) and len(messages) < wanted:
        end = data.find(b'\n', offset)
        if end < 0:
            raise ValueError('header')
        header = data[offset:end]
        offset = end + 1
        if header.endswith(b' missing'):
            continue
        match = _BATCH_HEADER.match(header)
        if not match:
            raise ValueError('header')
        size = int(match.group(3))
        body = data[offset:offset + size]
        if len(body) != size:
            raise ValueError('size')
        offset += size + 1
        if match.group(2) == b'commit':
            _, _, message = body.partition(b'\n\n')
            messages.append(message.decode('utf-8', errors='replace'))
    return messages


# ---------------------------------------------------------------------------
# The adapter
# ---------------------------------------------------------------------------

class GitAdapter:
    """`git-commit-exists`: `minCommits`, `messageContains`, and `ignoreCase`."""
    types = ('git-commit-exists',)

    def run(self, check, workspace, limits):
        try:
            fields = take_fields(check['runner'], {'messageContains': ('str', False), 'minCommits': ('int', False), 'ignoreCase': ('bool', False)})
            needle = fields.get('messageContains')
            if needle is not None and not 1 <= len(needle) <= 500:
                raise DescriptorError('The field messageContains must hold 1 to 500 characters.')
            minimum = fields.get('minCommits', 1)
            if not 1 <= minimum <= limits.max_min_count:
                raise DescriptorError(f'The field minCommits must be between 1 and {limits.max_min_count}.')
        except DescriptorError as error:
            return check_runner.bad_descriptor(error)
        git = find_git()
        if not git:
            return result('skipped', {'reason': 'git_unavailable'}, ['Git is not installed, so Schola cannot run this check. Report the result yourself (self-report).'])
        private = tempfile.mkdtemp(prefix=PRIVATE_PREFIX)
        try:
            gitdir = locate_git_dir(workspace)
            return self._check(git, gitdir, workspace, private, limits, needle, minimum, fields.get('ignoreCase', False))
        except GitProblem as problem:
            return problem.as_result()
        finally:
            _remove_private(private)

    def _check(self, git, gitdir, workspace, private, limits, needle, minimum, ignore_case):
        code, out, err = run_git(git, gitdir, workspace, private, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], limits)
        head = out.decode('ascii', errors='replace').strip()
        if code == 1 and not head:
            return result('failed', {'reason': 'no_commits', 'commits': 0, 'required': minimum}, ['This repository has no commits yet. Make a commit first.'])
        if code != 0 or not _SHA.match(head):
            return self._git_failed(code, err)
        evidence = {'head': head[:7], 'required': minimum}
        if needle is None:
            code, out, err = run_git(git, gitdir, workspace, private, ['rev-list', '--count', 'HEAD'], limits)
            text = out.decode('ascii', errors='replace').strip()
            if code != 0 or not text.isdigit():
                return self._git_failed(code, err)
            commits = int(text)
            evidence['commits'] = commits
            if commits >= minimum:
                return result('passed', evidence, [f'Found {commits} commits.'])
            return result('failed', evidence, ['There are not enough commits yet.'])
        code, out, err = run_git(git, gitdir, workspace, private, ['rev-list', f'--max-count={limits.git_max_scan}', 'HEAD'], limits)
        shas = [item for item in out.decode('ascii', errors='replace').split('\n') if item]
        if code != 0 or not shas or not all(_SHA.match(item) for item in shas):
            return self._git_failed(code, err)
        code, out, err = run_git(git, gitdir, workspace, private, ['cat-file', '--batch'], limits, ('\n'.join(shas) + '\n').encode('ascii'))
        if code != 0:
            return self._git_failed(code, err)
        try:
            messages = _parse_batch(out, len(shas))
        except ValueError:
            return result('error', {'reason': 'git_failed'}, ['Git gave an answer Schola could not read.'])
        wanted = needle.casefold() if ignore_case else needle
        matching = sum(1 for message in messages if wanted in (message.casefold() if ignore_case else message))
        evidence.update({'matching': matching, 'scanned': len(messages)})
        if matching >= minimum:
            return result('passed', evidence, [f'Found {matching} matching commits.'])
        return result('failed', evidence, ['Not enough commit messages contain that text.'])

    @staticmethod
    def _git_failed(code, err):
        if b'dubious ownership' in err:
            return result('error', {'reason': 'untrusted_repository'}, ['Git does not trust this repository because another user owns it.'])
        return result('error', {'reason': 'git_failed', 'exitCode': code}, ['Git could not read this repository.'])
