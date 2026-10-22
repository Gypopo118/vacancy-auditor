const startButton = document.querySelector('#start');
const status = document.querySelector('#status');
const empty = document.querySelector('#empty');
const loading = document.querySelector('#loading');
const report = document.querySelector('#report');

function node(tag, className, text) { const element = document.createElement(tag); if (className) element.className = className; if (text) element.textContent = text; return element; }
function list(values, className = '') { const ul = node('ul', className); (Array.isArray(values) ? values : []).filter(Boolean).forEach((value) => ul.append(node('li', '', String(value)))); return ul; }
function safeLink(label, href) { if (!href || !/^https:\/\//i.test(href)) return null; const link = node('a', '', label); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; return link; }

function render(data) {
  report.replaceChildren(); report.append(node('p', 'summary', data.overview || 'Проверка завершена.'));
  const stats = data.stats || {}; const statRow = node('div', 'stats'); const labels = { job: 'Job', makler: 'Makler', onlyJobByExactKey: 'Только Job', onlyMaklerByExactKey: 'Только Makler' };
  Object.entries(labels).forEach(([key, label]) => statRow.append(node('span', 'stat', `${label}: ${stats[key] ?? '—'}`))); report.append(statRow);
  const items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) { report.append(node('div', 'no-items', 'Замечаний не обнаружено.')); return; }
  const container = node('div', 'items');
  items.forEach((item) => {
    const card = node('article', 'item'); card.append(node('div', 'category', item.category || 'Замечание')); card.append(node('h2', '', [item.title || 'Вакансия', item.city ? `— ${item.city}` : ''].join(' ')));
    if (Array.isArray(item.findings) && item.findings.length) card.append(list(item.findings));
    if (Array.isArray(item.recommendations) && item.recommendations.length) card.append(list(item.recommendations, 'recommendations'));
    const links = node('div', 'links'); const jobLink = safeLink('Открыть на Job', item.jobUrl); const maklerLink = safeLink('Открыть на Makler', item.maklerUrl); if (jobLink) links.append(jobLink); if (maklerLink) links.append(maklerLink); if (links.childElementCount) card.append(links); container.append(card);
  });
  report.append(container);
}

startButton.addEventListener('click', async () => {
  startButton.disabled = true; empty.hidden = true; report.hidden = true; loading.hidden = false; status.textContent = 'Запущена проверка. Это может занять несколько минут.';
  try { const response = await fetch('/api/check', { method: 'POST' }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Не удалось выполнить проверку.'); render(data.report); status.textContent = `Проверка завершена: ${new Date(data.checkedAt).toLocaleString('ru-RU')}`; }
  catch (error) { report.replaceChildren(node('div', 'item error', error instanceof Error ? error.message : 'Неизвестная ошибка.')); status.textContent = 'Проверка завершилась с ошибкой.'; }
  finally { loading.hidden = true; report.hidden = false; startButton.disabled = false; }
});
