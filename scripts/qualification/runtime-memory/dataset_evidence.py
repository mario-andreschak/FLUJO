"""Linux qualification datasets belong to the owned ext4 volume, never DrvFs."""
import ctypes
import os
from pathlib import Path, PurePosixPath
import re
import shutil

ROOT = PurePosixPath('/opt/flujo569/qualification')


def validate_dataset_path(output, phase):
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,70}', phase):
        raise RuntimeError('Invalid dataset phase')
    expected = ROOT / phase / 'output'
    if str(output) != str(expected):
        raise RuntimeError('Linux dataset must use the exact owned ext4 path')
    return Path(str(expected))


def filesystem_provenance(directory):
    if os.name != 'posix':
        raise RuntimeError('Linux filesystem evidence requires Linux')
    directory = Path(directory)
    if directory.resolve(strict=True) != directory:
        raise RuntimeError('Dataset path contains a symlink')
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        libc.fstatfs.argtypes = [ctypes.c_int, ctypes.c_void_p]
        storage = ctypes.create_string_buffer(256)
        if libc.fstatfs(descriptor, storage):
            raise OSError(ctypes.get_errno(), 'fstatfs failed')
        magic = ctypes.cast(storage, ctypes.POINTER(ctypes.c_long))[0]
        if magic != 0xEF53:
            raise RuntimeError('Linux workload dataset is not on the ext4 filesystem')
        info = os.fstat(descriptor)
        return {'path': str(directory), 'realPath': str(directory.resolve()),
                'filesystemMagic': '0xef53', 'filesystem': 'ext4', 'device': info.st_dev, 'inode': info.st_ino}
    finally:
        os.close(descriptor)


def prepare_linux_dataset(output, phase):
    output = validate_dataset_path(output, phase)
    root = Path(str(ROOT))
    root.mkdir(mode=0o700, exist_ok=True)
    filesystem_provenance(root)
    # A unique phase must not reuse even an empty previous dataset directory.
    output.parent.mkdir(mode=0o700, exist_ok=False)
    filesystem_provenance(output.parent)
    return output


def inspect_linux_dataset(output, phase):
    return filesystem_provenance(validate_dataset_path(output, phase))


def guest_disk_admission(output, phase, required_bytes):
    provenance = inspect_linux_dataset(output, phase)
    free = shutil.disk_usage(output).free
    if free < required_bytes:
        raise RuntimeError('Guest ext4 filesystem lacks the combined reservation and floor')
    return {'filesystem': provenance, 'freeBytes': free, 'requiredFreeBytes': required_bytes}
