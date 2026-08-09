"""AssureCode scope-guard package.

The retrieval and anchoring adapters live in ``apps/ai-service/app/ports`` so
that there is exactly one implementation of the pgvector query and the genesis
hash lookup (see the note in ``app.deps``). Both services name their top-level
package ``app``, so ``app.ports`` is not reachable from here by putting
``apps/ai-service`` on ``sys.path`` alone: by the time ``app.deps`` runs, the
name ``app`` is already bound to *this* package, and submodule lookup searches
only this package's ``__path__``.

Until now that resolved by accident. ``apps/ai-service`` is installed editable
into its own virtualenv, whose import finder supplies ``app.ports``, so these
tests passed under ``apps/ai-service/.venv`` and failed with a bare
``ModuleNotFoundError: No module named 'app.ports'`` under any other
interpreter — including a plain ``python -m pytest`` in this directory.

Extending ``__path__`` states the arrangement instead of depending on it. This
package's own directory stays first, so ``app.main``, ``app.deps`` and
``app.services`` continue to resolve here, and only names this package does not
define — ``app.ports`` — fall through to ai-service.
"""
from __future__ import annotations

import os as _os

# apps/scope-guard/app/__init__.py -> apps/scope-guard/app -> apps/scope-guard -> apps
_APPS_DIR = _os.path.dirname(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))
_AI_SERVICE_APP = _os.path.join(_APPS_DIR, "ai-service", "app")

if _os.path.isdir(_AI_SERVICE_APP) and _AI_SERVICE_APP not in __path__:
    __path__.append(_AI_SERVICE_APP)
