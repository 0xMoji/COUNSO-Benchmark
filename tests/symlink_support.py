"""Skip only real-link controls when the host cannot create symbolic links."""


def symlink_or_skip(test, link, target, *, directory=False):
    try:
        link.symlink_to(target, target_is_directory=directory)
    except OSError as exc:
        if getattr(exc, 'winerror', None) != 1314:
            raise
        test.skipTest('Windows host lacks symlink privilege; real-link control not verified')
