// The chapter list of the film: a button per chapter seeks the video.
const CHAPTERS = [
  { title: 'The garden', at: 0 },
  { title: 'The lake', at: 1 },
];

const film = document.getElementById('film');
const nav = document.getElementById('chapters');

for (const chapter of CHAPTERS) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = chapter.title;
  button.addEventListener('click', () => {
    film.currentTime = chapter.at;
    film.play();
  });
  nav.appendChild(button);
}
