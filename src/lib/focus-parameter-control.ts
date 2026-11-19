/** Slider thumbs use role="slider" on a div, so native label activation cannot focus them. */
export function focusParameterControl(event: MouseEvent) {
  const label = event.currentTarget as HTMLLabelElement;
  const control = label.ownerDocument.getElementById(label.htmlFor);
  if (control && !control.matches(':disabled, [aria-disabled="true"]')) {
    control.focus({ preventScroll: true });
  }
}
