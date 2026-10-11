# Third-party dependency notices and license bounds

No project-wide redistribution license is granted for the toolkit's own code, schemas or fictional inputs. The notices below apply only to the named third-party dependencies. No dependency source/binary or browser binary is vendored here.

The Python runtime and bundled build backend have no third-party runtime/build dependencies. Optional JSON Schema test tooling is not installed or distributed by the clean-install path.

The UI offline/HTTP controls use only Node built-ins. Actual browser acceptance resolves the exact `adapters/standalone-ui/package-lock.json` dependency graph:

- `playwright` 1.57.0 and `playwright-core` 1.57.0: Apache-2.0, Microsoft/Google portions. Attribution: `../licenses/playwright-COPYRIGHT.txt` and `../licenses/playwright-NOTICE.txt`. The full license is retained by npm in the installed distribution and linked below. Official [license](https://github.com/microsoft/playwright/blob/v1.57.0/LICENSE) and [notice](https://github.com/microsoft/playwright/blob/v1.57.0/NOTICE).
- `fsevents` 2.3.2: MIT, optional macOS-only dependency. Full applicable copyright/license: `../licenses/fsevents-MIT.txt`. Official [license](https://github.com/fsevents/fsevents/blob/v2.3.2/LICENSE). The supported CI path is Linux and uses `npm ci --ignore-scripts`; it does not run this optional install script.

Keep upstream license/NOTICE files in any installed dependency distribution. The source references to Dust ([MIT license](https://github.com/dust-tt/dust/blob/f0d8be778a81eaf0dda8400cf0724e3064248c44/LICENSE)) and A2UI ([Apache-2.0 license with stated exceptions](https://github.com/a2ui-project/a2ui/blob/ce03d005c0575ff6708da583d9e7658a34df2d5d/LICENSE)) document optional platform contracts; their code/runtimes are not vendored or installed. They confer no Counso license or platform access. Official preinstalled Chrome is an external CI runner prerequisite, not a bundled redistributable.
