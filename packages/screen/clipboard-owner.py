"""Read X11 CLIPBOARD owner identity without requesting clipboard contents."""
import ctypes
import sys

x11 = ctypes.CDLL("libX11.so.6")
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
x11.XInternAtom.restype = ctypes.c_ulong
x11.XGetSelectionOwner.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XGetSelectionOwner.restype = ctypes.c_ulong
x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
x11.XCloseDisplay.restype = ctypes.c_int
connection = x11.XOpenDisplay(None)
if not connection:
    sys.exit(1)
try:
    selection = x11.XInternAtom(connection, b"CLIPBOARD", 0)
    print(x11.XGetSelectionOwner(connection, selection))
finally:
    x11.XCloseDisplay(connection)
