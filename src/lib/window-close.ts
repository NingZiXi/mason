interface CloseRequest { preventDefault(): void }

/** Confirm once, then destroy the window without issuing another close request. */
export function createWindowCloseHandler(
  confirmExit: () => Promise<boolean>,
  destroy: () => Promise<void>,
  onError: (error: unknown) => void,
) {
  let closing = false;
  return async (event: CloseRequest) => {
    event.preventDefault();
    if (closing) return;
    closing = true;
    try {
      if (await confirmExit()) await destroy();
    } catch (error) {
      onError(error);
    } finally {
      closing = false;
    }
  };
}
