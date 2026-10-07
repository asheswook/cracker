"""Release X11 pressed keys and mouse buttons after a desktop worker is stopped."""
import ctypes
import sys
x11 = ctypes.CDLL("libX11.so.6")
xtst = ctypes.CDLL("libXtst.so.6")
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XQueryKeymap.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x11.XDefaultRootWindow.restype = ctypes.c_ulong
x11.XQueryPointer.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
display = x11.XOpenDisplay(None)
if not display:
    sys.exit(1)
try:
    pressed = ctypes.create_string_buffer(32)
    if not x11.XQueryKeymap(display, pressed):
        sys.exit(1)
    for code in range(8, 256):
        if pressed.raw[code // 8] & (1 << (code % 8)):
            if not xtst.XTestFakeKeyEvent(display, code, 0, 0):
                sys.exit(1)
    for button in range(1, 6):
        if not xtst.XTestFakeButtonEvent(display, button, 0, 0):
            sys.exit(1)
    x11.XSync(display, 0)
    if not x11.XQueryKeymap(display, pressed) or any(pressed.raw):
        sys.exit(1)
    root, child = ctypes.c_ulong(), ctypes.c_ulong()
    coordinates = [ctypes.c_int() for _ in range(4)]
    mask = ctypes.c_uint()
    if not x11.XQueryPointer(display, x11.XDefaultRootWindow(display), ctypes.byref(root), ctypes.byref(child), *[ctypes.byref(value) for value in coordinates], ctypes.byref(mask)) or mask.value & 0x1F00:
        sys.exit(1)
finally:
    x11.XCloseDisplay(display)
