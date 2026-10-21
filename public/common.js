'use strict';
// Small helpers shared by the cashier screen and the admin.

// h('div', {class:'x', onclick: fn}, child, child...) -> element. Text children
// are added with textContent, so names typed in the admin can never inject HTML.
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') { for (const [p, val] of Object.entries(v)) p.startsWith('--') ? el.style.setProperty(p, val) : (el.style[p] = val); }
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Replace an element's content. Accepts nested arrays and skips empty values.
function put(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false).map((c) => (c.nodeType ? c : document.createTextNode(String(c)))));
}

const money = (cents) => '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const timeOf = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

class ApiError extends Error {
  constructor(status, body) { super(body.message || 'Request failed'); this.status = status; this.code = body.error; this.body = body; }
}
async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
      credentials: 'same-origin',
    });
  } catch (e) {
    throw new ApiError(0, { error: 'NETWORK', message: 'No connection to the server. Check the internet and try again.' });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json);
  return json;
}

function toast(message, kind) {
  const el = h('div', { class: 'toast ' + (kind || '') }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 5000 : 2200);
}

function dialog(title, body, actions, opts) {
  const o = opts || {};
  const close = () => { overlay.remove(); if (o.onclose) o.onclose(); };
  const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay && !o.sticky) close(); } },
    h('div', { class: 'dialog' + (o.wide ? ' wide' : ''), role: 'dialog', 'aria-label': title },
      h('h2', {}, title), body,
      h('div', { class: 'dialog-actions' }, (actions || []).map((a) => h('button', { class: 'btn ' + (a.class || ''), onclick: () => a.onclick ? a.onclick(close) : close() }, a.label)),
        h('button', { class: 'btn', onclick: close }, 'Close'))));
  document.body.append(overlay);
  return close;
}
