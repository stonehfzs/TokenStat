export function createBudgetNotifier(Notification, { icon, onClick }) {
  const notices = new Set();

  return function notifyBudget(payload) {
    const { title, body } = payload ?? {};
    if (!Notification.isSupported() || typeof title !== 'string' || !title.trim() || title.length > 120 ||
        typeof body !== 'string' || !body.trim() || body.length > 400) return false;

    return new Promise((resolve) => {
      const notification = new Notification({ title, body, icon, silent: true });
      notices.add(notification);
      const expiry = setTimeout(() => notices.delete(notification), 60_000).unref();
      // Some desktop shells delay the show event or suppress a notification.
      // A successful show() submission counts when the shell provides no receipt.
      const receipt = setTimeout(() => resolve(true), 2000).unref();
      const release = () => { notices.delete(notification); clearTimeout(expiry); };
      notification.once('show', () => { clearTimeout(receipt); resolve(true); });
      notification.once('failed', () => { clearTimeout(receipt); release(); resolve(false); });
      notification.once('close', release);
      notification.once('click', () => { release(); onClick(); });
      try {
        notification.show();
      } catch {
        clearTimeout(receipt);
        release();
        resolve(false);
      }
    });
  };
}
