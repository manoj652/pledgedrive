(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const state = { dashboard: null, loading: false, uploading: false, toastTimer: null };
  const fileList = $('#files');
  const nodeList = $('#nodes');

  class ApiError extends Error {
    constructor(message, status, requestId) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.requestId = requestId;
    }
  }

  const formatBytes = (value) => {
    if (!Number.isFinite(value) || value < 0) return '—';
    if (value < 1024) return `${value} B`;
    const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
    let amount = value;
    let unit = -1;
    do { amount /= 1024; unit += 1; } while (amount >= 1024 && unit < units.length - 1);
    const digits = amount >= 100 || unit === 0 ? 0 : amount >= 10 ? 1 : 2;
    return `${amount.toFixed(digits)} ${units[unit]}`;
  };

  const formatPercent = (value) => `${Math.max(0, Math.min(100, value * 100)).toFixed(1)}%`;

  const setBusy = (element, busy) => {
    if (!element) return;
    element.disabled = busy;
    element.setAttribute('aria-busy', String(busy));
  };

  const showToast = (message, type = 'info') => {
    const toast = $('#toast');
    if (!toast) return;
    window.clearTimeout(state.toastTimer);
    toast.textContent = message;
    toast.className = `toast toast-${type}`;
    toast.hidden = false;
    state.toastTimer = window.setTimeout(() => { toast.hidden = true; }, 5000);
  };

  const showUploadStatus = (message, visible = true) => {
    const status = $('#upload-status');
    if (!status) return;
    status.textContent = message;
    status.hidden = !visible;
  };

  const api = async (path, options = {}) => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), options.timeout || 20000);
    try {
      const response = await fetch(path, {
        credentials: 'same-origin',
        ...options,
        signal: controller.signal,
        headers: { accept: 'application/json', ...(options.headers || {}) }
      });
      const raw = await response.text();
      let payload = null;
      if (raw) {
        try { payload = JSON.parse(raw); } catch { payload = null; }
      }
      if (!response.ok) throw new ApiError(payload?.error || `Request failed (${response.status})`, response.status, payload?.requestId || response.headers.get('x-request-id'));
      return payload;
    } catch (error) {
      if (error.name === 'AbortError') throw new ApiError('The request timed out. Please retry.', 408);
      if (error instanceof ApiError) throw error;
      throw new ApiError('Network unavailable. Check the server and retry.', 0);
    } finally {
      window.clearTimeout(timeout);
    }
  };

  const emptyState = (title, copy) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'empty-state';
    const heading = document.createElement('strong');
    heading.textContent = title;
    const description = document.createElement('span');
    description.textContent = copy;
    wrapper.append(heading, description);
    return wrapper;
  };

  const renderFiles = (files) => {
    fileList.replaceChildren();
    if (!files.length) {
      fileList.append(emptyState('No files yet', 'Upload a file and PledgeDrive will distribute encrypted replicas across the network.'));
      return;
    }
    for (const file of files) {
      const row = document.createElement('article');
      row.className = 'file-row';
      const icon = document.createElement('span');
      icon.className = 'file-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = '↗';
      const details = document.createElement('div');
      details.className = 'row-details';
      const name = document.createElement('strong');
      name.textContent = file.name;
      const replicaCount = (file.chunks || []).reduce((total, chunk) => total + (chunk.replicaCount ?? chunk.replicas?.length ?? 0), 0);
      const meta = document.createElement('span');
      meta.textContent = `${formatBytes(file.size)} · ${file.chunks?.length || 0} chunks · ${replicaCount} replicas`;
      details.append(name, meta);
      const actions = document.createElement('div');
      actions.className = 'row-actions';
      const download = document.createElement('a');
      download.className = 'text-link';
      download.href = `/api/files/${encodeURIComponent(file.id)}`;
      download.download = file.name;
      download.textContent = 'Download';
      download.setAttribute('aria-label', `Download ${file.name}`);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'icon-button danger-button';
      remove.textContent = '×';
      remove.title = 'Delete file';
      remove.setAttribute('aria-label', `Delete ${file.name}`);
      remove.addEventListener('click', async () => {
        if (!window.confirm(`Delete “${file.name}” from PledgeDrive?`)) return;
        setBusy(remove, true);
        try {
          await api(`/api/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' });
          showToast('File deleted and replica capacity released.', 'success');
          await load();
        } catch (error) {
          setBusy(remove, false);
          showToast(error.message, 'error');
        }
      });
      actions.append(download, remove);
      row.append(icon, details, actions);
      fileList.append(row);
    }
  };

  const renderNodes = (nodes) => {
    nodeList.replaceChildren();
    if (!nodes.length) {
      nodeList.append(emptyState('No contribution devices', 'Add a desktop, server, or NAS node to help store encrypted replicas.'));
      return;
    }
    for (const node of nodes) {
      const row = document.createElement('article');
      row.className = 'node-row';
      const details = document.createElement('div');
      details.className = 'row-details';
      const name = document.createElement('strong');
      name.textContent = node.deviceId;
      const meta = document.createElement('span');
      meta.textContent = `${formatBytes(node.usedBytes)} used of ${formatBytes(node.pledgedBytes)} pledged · ${formatPercent(node.reliabilityScore)} reliability`;
      details.append(name, meta);
      const status = document.createElement('span');
      status.className = `status-badge status-${String(node.status).toLowerCase()}`;
      status.textContent = `● ${node.status}`;
      row.append(details, status);
      nodeList.append(row);
    }
  };

  const stat = (value, label, detail = '') => {
    const card = document.createElement('div');
    card.className = 'stat-card';
    const valueElement = document.createElement('strong');
    valueElement.textContent = value;
    const labelElement = document.createElement('span');
    labelElement.textContent = label;
    card.append(valueElement, labelElement);
    if (detail) {
      const detailElement = document.createElement('small');
      detailElement.textContent = detail;
      card.append(detailElement);
    }
    return card;
  };

  const renderStats = (network) => {
    const stats = $('#stats');
    stats.replaceChildren(
      stat(String(network.onlineNodes ?? 0), 'nodes online', `${network.nodes} registered`),
      stat(formatBytes(network.pledgedBytes), 'pledged capacity', `${formatBytes(network.onlineBytes)} free online`),
      stat(formatBytes(network.allocatedBytes), 'allocated', `${formatBytes(network.verifiedBytes)} verified`),
      stat(formatPercent(network.replicationHealth ?? 1), 'replication health', `${network.healthyChunks}/${network.totalChunks} chunks healthy`)
    );
    const status = $('#network-status');
    status.textContent = network.onlineNodes > 0 ? 'Network live' : 'Network degraded';
    status.parentElement.classList.toggle('network-degraded', network.onlineNodes === 0);
  };

  const render = (dashboard) => {
    state.dashboard = dashboard;
    const quota = dashboard.quota;
    const ratio = quota.quotaBytes ? quota.usedBytes / quota.quotaBytes : 0;
    $('#usage').textContent = `${formatBytes(quota.usedBytes)} / ${formatBytes(quota.quotaBytes)}`;
    $('#progress-fill').style.width = `${Math.min(100, ratio * 100)}%`;
    $('#progress').setAttribute('aria-valuenow', String(Math.round(Math.min(100, ratio * 100))));
    $('#quota-help').textContent = `Included quota: ${formatBytes(quota.quotaBytes)}`;
    $('#quota-percent').textContent = formatPercent(ratio);
    renderFiles(dashboard.files || []);
    renderNodes(dashboard.nodes || []);
    renderStats(dashboard.network || {});
  };

  const load = async () => {
    if (state.loading) return;
    state.loading = true;
    setBusy($('#refresh'), true);
    try {
      render(await api('/api/dashboard'));
    } catch (error) {
      showToast(error.message, 'error');
      $('#network-status').textContent = 'Connection unavailable';
    } finally {
      state.loading = false;
      setBusy($('#refresh'), false);
    }
  };

  const uploadFile = (file) => new Promise((resolveUpload, rejectUpload) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload?name=${encodeURIComponent(file.name)}`);
    xhr.responseType = 'json';
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) showUploadStatus(`Uploading ${Math.round((event.loaded / event.total) * 100)}%`);
    });
    xhr.addEventListener('error', () => rejectUpload(new ApiError('Network unavailable. Check the server and retry.', 0)));
    xhr.addEventListener('timeout', () => rejectUpload(new ApiError('The upload timed out. Please retry.', 408)));
    xhr.timeout = 120000;
    xhr.addEventListener('load', () => {
      const payload = xhr.response || (() => { try { return JSON.parse(xhr.responseText); } catch { return null; } })();
      if (xhr.status >= 200 && xhr.status < 300) resolveUpload(payload);
      else rejectUpload(new ApiError(payload?.error || `Upload failed (${xhr.status})`, xhr.status, payload?.requestId));
    });
    xhr.send(file);
  });

  const handleUpload = async (file) => {
    if (!file || state.uploading) return;
    state.uploading = true;
    setBusy($('#refresh'), true);
    $('#upload-label').textContent = 'Uploading…';
    showUploadStatus(`Preparing ${file.name}`);
    try {
      await uploadFile(file);
      showUploadStatus('Upload complete. Replicas verified.', true);
      showToast(`${file.name} is safely replicated.`, 'success');
      await load();
      window.setTimeout(() => showUploadStatus('', false), 3500);
    } catch (error) {
      showUploadStatus(error.message, true);
      showToast(error.message, 'error');
    } finally {
      state.uploading = false;
      $('#upload-label').textContent = 'Upload a file';
      setBusy($('#refresh'), false);
    }
  };

  $('#upload').addEventListener('change', async (event) => {
    const input = event.target;
    const file = input.files?.[0];
    input.value = '';
    await handleUpload(file);
  });
  const uploadButton = $('.upload-button');
  uploadButton.addEventListener('dragover', (event) => { event.preventDefault(); uploadButton.classList.add('dragging'); });
  uploadButton.addEventListener('dragleave', () => uploadButton.classList.remove('dragging'));
  uploadButton.addEventListener('drop', async (event) => {
    event.preventDefault();
    uploadButton.classList.remove('dragging');
    await handleUpload(event.dataTransfer?.files?.[0]);
  });

  const dialog = $('#dialog');
  const closeDialog = () => dialog.close();
  $('#add').addEventListener('click', () => dialog.showModal());
  $('#cancel').addEventListener('click', closeDialog);
  $('#cancel-top').addEventListener('click', closeDialog);
  dialog.addEventListener('click', (event) => { if (event.target === dialog) closeDialog(); });
  $('#node-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const save = $('#save');
    const pledgeGb = Number($('#pledge').value);
    if (!Number.isSafeInteger(pledgeGb) || pledgeGb < 1) return showToast('Enter a valid pledged capacity.', 'error');
    setBusy(save, true);
    try {
      await api('/api/nodes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: $('#device').value, region: 'IN', platform: $('#platform').value, version: '0.1.0', capacityBytes: 1000 * 1024 ** 3, pledgedBytes: pledgeGb * 1024 ** 3, bandwidthMbps: 50 }) });
      closeDialog();
      showToast('Device registered and ready to contribute.', 'success');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      setBusy(save, false);
    }
  });

  $('#repair').addEventListener('click', async () => {
    const repair = $('#repair');
    setBusy(repair, true);
    try {
      const result = await api('/api/repair', { method: 'POST' });
      showToast(result.repaired ? `Repaired ${result.repaired} replica(s).` : 'All replicas are healthy.', 'success');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      setBusy(repair, false);
    }
  });

  $('#file-search').addEventListener('input', (event) => {
    if (!state.dashboard) return;
    const query = event.target.value.trim().toLowerCase();
    renderFiles((state.dashboard.files || []).filter((file) => file.name.toLowerCase().includes(query)));
  });
  window.addEventListener('online', load);
  load();
})();
