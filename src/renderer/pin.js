const image = document.getElementById('pinned-image');
const closeButton = document.getElementById('pin-close');

window.luvoelle.onPinnedImageInit((payload) => {
  image.onload = () => { document.body.dataset.ready = 'true'; };
  image.src = payload.dataUrl;
  document.body.dataset.imageSize = `${payload.width}x${payload.height}`;
});

closeButton.addEventListener('click', () => window.luvoelle.closePinnedImage());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') event.preventDefault();
});
document.addEventListener('contextmenu', (event) => event.preventDefault());
