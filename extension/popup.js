document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('openOptions').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
  document.getElementById('newService').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('wizard.html') });
  });

  const registry = new ServiceRegistry();
  const services = await registry.getAll();
  const enabled = services.filter(s => s.config.enabled).length;
  document.getElementById('statusText').textContent = `${enabled}/${services.length} services active`;
});
