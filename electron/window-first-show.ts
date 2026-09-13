type ReadySource = {
  once(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
};

// Some Wayland compositors defer the first frame of a hidden window. Waiting
// only for ready-to-show then leaves that window hidden after its page loads.
export function onWindowFirstShow(
  win: ReadySource & { webContents: ReadySource },
  nativeWayland: boolean,
  show: () => void,
): void {
  let done = false;
  const cleanup = () => {
    win.removeListener('ready-to-show', reveal);
    win.removeListener('closed', cancel);
    win.webContents.removeListener('did-finish-load', reveal);
  };
  const reveal = () => {
    if (done) return;
    done = true;
    cleanup();
    show();
  };
  const cancel = () => {
    done = true;
    cleanup();
  };
  win.once('ready-to-show', reveal);
  win.once('closed', cancel);
  if (nativeWayland) win.webContents.once('did-finish-load', reveal);
}
