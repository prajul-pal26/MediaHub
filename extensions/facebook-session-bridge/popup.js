async function show() {
  const status = await chrome.runtime.sendMessage({ action: 'status' });
  document.getElementById('status').textContent = [status.state.replaceAll('_', ' '), status.expectedUser ? `Account ${status.expectedUser}` : '', status.checkedAt ? new Date(status.checkedAt).toLocaleString() : ''].filter(Boolean).join(' · ');
}
document.getElementById('stop').addEventListener('click', async () => {
  const result = await chrome.runtime.sendMessage({ action: 'stop' });
  document.getElementById('status').textContent = result.revoked ? 'Stopped and access revoked.' : 'Stopped in Chrome. Use Stop in MediaHub Settings to ensure server access is revoked.';
});
void show();
