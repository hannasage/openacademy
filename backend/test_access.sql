-- Access tests no longer accept a remote connection or change a deployment.
-- Run from the Schola project directory:
--   python3 -m unittest discover -s backend/tests -p 'test_*.py' -v
-- The runner creates and removes its own temporary, socket-only Postgres cluster.
\echo 'Use the disposable database runner documented in backend/README.md.'
\quit 1
