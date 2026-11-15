/**
 * Read-only judge demo client.
 *
 * Lists the curated demonstration products and renders the reviewed public
 * support card returned by the existing public API. It never calls a mutation
 * endpoint: extraction, import, research and review stay behind login.
 */
(function () {
  var listEl = document.getElementById('product-list');
  var statusEl = document.getElementById('demo-list-status');
  var resultEl = document.getElementById('demo-result');
  var countEl = document.getElementById('demo-count');
  if (!listEl || !statusEl || !resultEl) return;

  var selectedId = null;
  var products = [];

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function statusLabel(status) {
    if (status === 'CONFLICTING_INFORMATION') return 'Conflicting information';
    if (status === 'INSUFFICIENT_INFORMATION') return 'Insufficient information';
    return 'Information available';
  }

  function statusClass(status) {
    if (status === 'CONFLICTING_INFORMATION') return 'status-pill status-pill--conflicting';
    if (status === 'INSUFFICIENT_INFORMATION') return 'status-pill status-pill--insufficient';
    return 'status-pill status-pill--available';
  }

  function dateText(commitment) {
    if (!commitment) return 'Not published';
    return commitment.displayValue || commitment.value || 'Not published';
  }

  function renderError(message, retry) {
    resultEl.replaceChildren();
    var panel = el('div', 'panel panel--error');
    panel.appendChild(el('h3', null, 'The demonstration is temporarily unavailable'));
    panel.appendChild(el('p', null, message || 'Please try again in a moment.'));
    if (retry) {
      var button = el('button', 'demo-retry', 'Try again');
      button.type = 'button';
      button.addEventListener('click', function () {
        loadProducts();
      });
      panel.appendChild(button);
    }
    resultEl.appendChild(panel);
    resultEl.setAttribute('aria-busy', 'false');
  }

  function renderEmpty() {
    resultEl.replaceChildren();
    var panel = el('div', 'panel panel--empty');
    panel.appendChild(el('h3', null, 'Demonstration data is not available yet.'));
    panel.appendChild(el('p', null, 'The curated records have not been loaded into this workspace.'));
    resultEl.appendChild(panel);
    resultEl.setAttribute('aria-busy', 'false');
  }

  function renderProduct(product) {
    resultEl.replaceChildren();
    var panel = el('div', 'panel');

    var head = el('div', 'support-summary__head');
    head.appendChild(el('p', 'support-summary__brand', product.manufacturer.name));
    head.appendChild(el('h2', null, product.name));
    var modelParts = [];
    if (product.modelIdentifier) modelParts.push(product.modelIdentifier);
    if (product.category) modelParts.push(product.category);
    if (modelParts.length) head.appendChild(el('p', 'support-summary__model', modelParts.join(' · ')));
    head.appendChild(el('span', statusClass(product.supportInformation.status), statusLabel(product.supportInformation.status)));
    panel.appendChild(head);

    var body = el('div', 'support-summary__body');
    body.appendChild(el('p', 'support-summary__summary', product.supportInformation.summaryStatement));

    var dates = el('div', 'demo-dates');
    [
      ['Support start', product.supportInformation.supportStart],
      ['Support end', product.supportInformation.supportEnd],
    ].forEach(function (entry) {
      var item = el('div', 'demo-date');
      item.appendChild(el('span', null, entry[0]));
      item.appendChild(el('strong', 'demo-date__value', dateText(entry[1])));
      if (entry[1] && entry[1].precision) {
        item.appendChild(el('span', 'demo-date__precision', entry[1].precision + ' precision'));
      }
      dates.appendChild(item);
    });
    body.appendChild(dates);

    var evidence = el('div', 'demo-evidence');
    var evidenceHead = el('div', 'demo-evidence__head');
    evidenceHead.appendChild(el('h3', null, 'Accepted claims (' + product.supportInformation.claims.length + ')'));
    evidenceHead.appendChild(el('p', null, 'Only evidence accepted by a reviewer is published here.'));
    evidence.appendChild(evidenceHead);

    product.supportInformation.claims.forEach(function (claim) {
      var card = el('article', 'claim-card');
      var top = el('div', 'claim-card__top');
      top.appendChild(el('span', 'claim-kind', claim.claimType.replace(/_/g, ' ')));
      top.appendChild(el('span', 'claim-accepted', 'Accepted'));
      card.appendChild(top);
      card.appendChild(el('p', null, claim.statement));
      card.appendChild(el('blockquote', null, '“' + claim.quotation + '”'));
      if (claim.dateText) {
        var meta = el('p', 'claim-card__meta', 'Date: ' + claim.dateText);
        card.appendChild(meta);
      }
      if (claim.source) {
        var source = el('p', 'claim-card__meta');
        source.appendChild(document.createTextNode('Source: '));
        var link = el('a', null, claim.source.title || claim.source.domain);
        link.href = claim.source.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        source.appendChild(link);
        card.appendChild(source);
      }
      evidence.appendChild(card);
    });
    body.appendChild(evidence);

    body.appendChild(el('p', 'support-summary__disclaimer', product.supportInformation.disclaimer));
    panel.appendChild(body);
    resultEl.appendChild(panel);
    resultEl.setAttribute('aria-busy', 'false');
  }

  function selectProduct(id) {
    selectedId = id;
    Array.prototype.forEach.call(listEl.children, function (child) {
      var active = child.getAttribute('data-product-id') === id;
      child.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    resultEl.setAttribute('aria-busy', 'true');
    renderLoading();
    loadCard(id);
  }

  function renderLoading() {
    resultEl.replaceChildren();
    var panel = el('div', 'panel panel--loading');
    panel.appendChild(el('span', 'loading-mark'));
    panel.appendChild(el('p', null, 'Loading the reviewed support record…'));
    resultEl.appendChild(panel);
  }

  async function loadCard(id) {
    try {
      var response = await fetch('/api/v1/public/products/' + encodeURIComponent(id) + '/support-card');
      var body = await response.json().catch(function () { return null; });
      if (!response.ok || !body || !body.data) {
        throw new Error((body && body.error && body.error.message) || 'Request failed');
      }
      renderProduct(body.data);
      if (statusEl) statusEl.hidden = true;
    } catch (error) {
      renderError('The reviewed support record could not be loaded.', true);
    }
  }

  function renderList() {
    listEl.replaceChildren();
    products.forEach(function (product) {
      var button = el('button', 'product-option');
      button.type = 'button';
      button.setAttribute('data-product-id', product.id);
      button.setAttribute('aria-pressed', 'false');
      button.appendChild(el('span', 'product-option__brand', product.manufacturer));
      button.appendChild(el('span', 'product-option__name', product.name));
      if (product.modelIdentifier) {
        button.appendChild(el('span', 'product-option__model', product.modelIdentifier));
      }
      var status = el('span', 'product-option__status');
      status.appendChild(el('span', 'product-option__dot'));
      status.appendChild(document.createTextNode(statusLabel(product.status)));
      button.appendChild(status);
      button.addEventListener('click', function () {
        selectProduct(product.id);
      });
      listEl.appendChild(button);
    });
  }

  async function loadProducts() {
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.textContent = 'Loading demonstration products…';
    }
    resultEl.setAttribute('aria-busy', 'true');
    try {
      var response = await fetch('/api/v1/public/demo/products');
      var body = await response.json().catch(function () { return null; });
      if (!response.ok || !body || !Array.isArray(body.data)) {
        throw new Error('Request failed');
      }
      products = body.data;
      if (countEl) countEl.textContent = String(products.length);
      if (!products.length) {
        renderEmpty();
        return;
      }
      renderList();
      if (statusEl) statusEl.hidden = true;
      selectProduct(products[0].id);
    } catch (error) {
      if (statusEl) {
        statusEl.hidden = false;
        statusEl.textContent = 'The demonstration is temporarily unavailable.';
      }
      renderError('The demonstration product list could not be loaded.', true);
    }
  }

  loadProducts();
})();
