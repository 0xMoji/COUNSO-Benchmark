"""Load RECON-0.2 beside an already-imported legacy package, without mutation."""
from importlib import import_module, util
from pathlib import Path
import sys


def load_helper(revision_root):
    package_dir = Path(revision_root).resolve() / 'counso_bench'
    name = 'counso_recon02'
    if name in sys.modules:
        if Path(sys.modules[name].__file__).resolve() != package_dir / '__init__.py':
            raise ValueError('Revision namespace already refers to another package')
    else:
        spec = util.spec_from_file_location(name, package_dir / '__init__.py',
                                          submodule_search_locations=[str(package_dir)])
        module = util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return import_module(name + '.revision_semantics').evaluate_equivalence


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python examples/load_revision_helper.py REVISED_PACKAGE_ROOT')
    helper = load_helper(sys.argv[1])
    print('Loaded pure semantic helper:', helper.__module__)
    print('No scores changed. Authenticate original evidence before calling it.')
