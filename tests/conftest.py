"""Test isolation: never touch the developer's real ~/.chamfer.

Points CHAMFER_HOME at a throwaway dir for the whole session and disables the
first-run seeding, so running the suite has no side effects on the real home
and no test accidentally launches the default build123d MCP server.
"""

import pytest


@pytest.fixture(autouse=True, scope="session")
def _isolate_chamfer_home(tmp_path_factory):
    import os

    home = tmp_path_factory.mktemp("chamfer-home")
    prev = {k: os.environ.get(k) for k in ("CHAMFER_HOME", "CHAMFER_NO_SEED")}
    os.environ["CHAMFER_HOME"] = str(home)
    os.environ["CHAMFER_NO_SEED"] = "1"
    try:
        yield home
    finally:
        for key, value in prev.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
