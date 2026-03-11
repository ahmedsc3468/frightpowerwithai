// A lightweight service that stores a reference to React Router's navigate
// function so it can be called from non-component modules (e.g. session.js).
// Register the navigate function once in the top-level App component via
// `setNavigate(navigate)` and it will be used wherever `getNavigate()` is called.

let _navigate = null;

export function setNavigate(navigateFn) {
  _navigate = navigateFn;
}

export function getNavigate() {
  return _navigate;
}
