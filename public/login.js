(function () {
  const form = document.getElementById('login-form');
  const alertBox = document.getElementById('login-alert');
  const submit = document.getElementById('login-submit');
  const params = new URLSearchParams(window.location.search);

  function safeNext() {
    const next = params.get('next');
    if (!next) return '/dashboard';
    const isDashboardPath =
      next === '/dashboard' || next.startsWith('/dashboard/') || next.startsWith('/dashboard?');
    if (!isDashboardPath || next.startsWith('//') || next.includes('\\')) return '/dashboard';
    return next;
  }

  function showError(message) {
    alertBox.textContent = message;
    alertBox.hidden = false;
  }

  if (params.get('expired') === '1') {
    showError('Your session expired. Sign in again to continue.');
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    alertBox.hidden = true;

    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Signing in…';

    try {
      const response = await fetch('/api/v1/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          email: document.getElementById('email').value,
          password: document.getElementById('password').value,
        }),
      });

      const body = await response.json().catch(() => null);

      if (!response.ok) {
        if (response.status === 429) {
          showError('Too many sign-in attempts. Wait a few minutes and try again.');
        } else if (body && body.error && body.error.message) {
          showError(body.error.message);
        } else {
          showError('Sign in failed. Try again.');
        }
        return;
      }

      window.location.assign(safeNext());
    } catch {
      showError('Could not reach the server. Check your connection and try again.');
    } finally {
      submit.disabled = false;
      submit.textContent = 'Sign in';
    }
  });
})();
