// Bottom-right transient notification banner. Single global toast element
// in index.html; subsequent calls overwrite the message and reset the
// auto-hide timer.

export function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

// Helper used by overlay backdrops — close the modal only when the click
// landed on the backdrop itself, not on the modal body.
export function closeModalOutside(e, id) {
  if (e.target.classList.contains('overlay')) {
    document.getElementById(id).style.display = 'none';
  }
}
