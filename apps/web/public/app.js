(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const state = { dashboard: null, user: null, authenticated: false, authMode: 'login', loading: false, uploading: false, toastTimer: null };
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

  const categoryLabel = (category) => ({ image: 'Photo', video: 'Video', audio: 'Audio', document: 'Document', archive: 'Archive', text: 'Text', other: 'File' }[category] || 'File');
  const categoryIcon = (category) => ({ image: '▧', video: '▶', audio: '♪', document: '▤', archive: '⌘', text: '≡', other: '↗' }[category] || '↗');
  const canPreview = (file) => ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/flac', 'application/pdf'].includes(file.mimeType);

  const visibleFiles = () => {
    const query = $('#file-search').value.trim().toLowerCase();
    const category = $('#file-filter').value;
    return (state.dashboard?.files || []).filter((file) => (!query || file.name.toLowerCase().includes(query)) && (category === 'all' || file.category === category));
  };

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

  const openDialog = (dialog) => {
    if (!dialog) return;
    if (typeof dialog.showModal === 'function') {
      try { dialog.showModal(); return; } catch { /* Fall back for embedded browsers. */ }
    }
    dialog.setAttribute('open', '');
  };

  const closeDialogElement = (dialog) => {
    if (!dialog) return;
    if (typeof dialog.close === 'function') {
      try { dialog.close(); return; } catch { /* Fall back for embedded browsers. */ }
    }
    dialog.removeAttribute('open');
  };

  const previewDialog = $('#preview-dialog');
  const openPreview = (file) => {
    const content = $('#preview-content');
    content.replaceChildren();
    $('#preview-title').textContent = file.name;
    const source = `/api/files/${encodeURIComponent(file.id)}?inline=1`;
    if (file.category === 'image') {
      const image = document.createElement('img');
      image.src = source;
      image.alt = file.name;
      content.append(image);
    } else if (file.category === 'video') {
      const video = document.createElement('video');
      video.src = source;
      video.controls = true;
      video.preload = 'metadata';
      content.append(video);
    } else if (file.category === 'audio') {
      const audio = document.createElement('audio');
      audio.src = source;
      audio.controls = true;
      content.append(audio);
    } else if (file.mimeType === 'application/pdf') {
      const frame = document.createElement('iframe');
      frame.src = source;
      frame.title = `Preview of ${file.name}`;
      content.append(frame);
    } else {
      const message = document.createElement('p');
      message.className = 'preview-message';
      message.textContent = 'Preview is not available for this format yet. Download the original file instead.';
      content.append(message);
    }
    openDialog(previewDialog);
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
      icon.textContent = categoryIcon(file.category);
      const details = document.createElement('div');
      details.className = 'row-details';
      const name = document.createElement('strong');
      name.textContent = file.name;
      const replicaCount = (file.chunks || []).reduce((total, chunk) => total + (chunk.replicaCount ?? chunk.replicas?.length ?? 0), 0);
      const meta = document.createElement('span');
      meta.textContent = `${categoryLabel(file.category)} · ${formatBytes(file.size)} · ${file.chunks?.length || 0} chunks · ${replicaCount} replicas`;
      details.append(name, meta);
      const actions = document.createElement('div');
      actions.className = 'row-actions';
      if (canPreview(file)) {
        const preview = document.createElement('button');
        preview.type = 'button';
        preview.className = 'text-button preview-button';
        preview.textContent = 'Preview';
        preview.setAttribute('aria-label', `Preview ${file.name}`);
        preview.addEventListener('click', () => openPreview(file));
        actions.append(preview);
      }
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
      nodeList.append(emptyState('No registered storage nodes', 'Register a desktop, server, or NAS node to contribute encrypted capacity.'));
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
    renderFiles(visibleFiles());
    renderNodes(dashboard.nodes || []);
    renderStats(dashboard.network || {});
  };

  const renderAccount = () => {
    const button = $('#account');
    button.textContent = state.authenticated && state.user?.email ? state.user.email.split('@')[0] : 'Sign in';
    $('#auth-form').hidden = state.authenticated;
    $('#account-session').hidden = !state.authenticated;
    if (state.user) {
      $('#account-title').textContent = state.user.email?.split('@')[0] || 'Account';
      $('#account-email').textContent = state.user.email || 'Signed-in account';
    }
  };

  const loadSession = async () => {
    try {
      const session = await api('/api/auth/me');
      state.authenticated = Boolean(session?.authenticated);
      state.user = session?.user || null;
    } catch {
      state.authenticated = false;
      state.user = null;
    }
    renderAccount();
  };

  const load = async () => {
    if (state.loading) return;
    state.loading = true;
    setBusy($('#refresh'), true);
    try {
      await loadSession();
      render(await api('/api/dashboard'));
    } catch (error) {
      showToast(error.message, 'error');
      $('#network-status').textContent = 'Connection unavailable';
      if (error.status === 401) showToast('Sign in to access your cloud files.', 'info');
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
  const closeNodeDialog = () => closeDialogElement(dialog);
  $('#add').addEventListener('click', () => openDialog(dialog));
  $('#cancel').addEventListener('click', closeNodeDialog);
  $('#cancel-top').addEventListener('click', closeNodeDialog);
  dialog.addEventListener('click', (event) => { if (event.target === dialog) closeNodeDialog(); });
  $('#node-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const save = $('#save');
    const capacityGb = Number($('#capacity').value);
    const pledgeGb = Number($('#pledge').value);
    if (!Number.isSafeInteger(capacityGb) || capacityGb < 1 || !Number.isSafeInteger(pledgeGb) || pledgeGb < 1 || pledgeGb > capacityGb) return showToast('Enter valid physical and pledged capacity values.', 'error');
    setBusy(save, true);
    try {
      await api('/api/nodes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: $('#device').value, region: 'IN', platform: $('#platform').value, version: '0.1.0', capacityBytes: capacityGb * 1024 ** 3, pledgedBytes: pledgeGb * 1024 ** 3, bandwidthMbps: 50 }) });
      closeNodeDialog();
      showToast('Device registered and ready to contribute.', 'success');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      setBusy(save, false);
    }
  });

  const authDialog = $('#auth-dialog');
  const setAuthMode = (mode) => {
    state.authMode = mode;
    const registering = mode === 'register';
    $('#auth-title').textContent = registering ? 'Create your account' : 'Sign in';
    $('#auth-copy').textContent = registering ? 'Start with 5 GB of private cloud storage, then add devices when you are ready.' : 'Sign in to keep your files and devices tied to your account.';
    $('#auth-submit').textContent = registering ? 'Create account' : 'Sign in';
    $('#auth-switch').textContent = registering ? 'Already have an account? Sign in' : 'Create an account';
    $('#auth-password').setAttribute('autocomplete', registering ? 'new-password' : 'current-password');
  };
  const openAccount = () => {
    renderAccount();
    openDialog(authDialog);
  };
  $('#account').addEventListener('click', openAccount);
  $('#auth-close').addEventListener('click', () => closeDialogElement(authDialog));
  $('#account-close').addEventListener('click', () => closeDialogElement(authDialog));
  authDialog.addEventListener('click', (event) => { if (event.target === authDialog) closeDialogElement(authDialog); });
  $('#auth-switch').addEventListener('click', () => setAuthMode(state.authMode === 'login' ? 'register' : 'login'));
  $('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = $('#auth-submit');
    setBusy(submit, true);
    try {
      const response = await api(`/api/auth/${state.authMode}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: $('#auth-email').value, password: $('#auth-password').value }) });
      state.authenticated = Boolean(response?.authenticated);
      state.user = response?.user || null;
      $('#auth-password').value = '';
      closeDialogElement(authDialog);
      renderAccount();
      showToast(state.authMode === 'register' ? 'Account created. Your 5 GB cloud is ready.' : 'Welcome back.', 'success');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      setBusy(submit, false);
    }
  });
  $('#logout').addEventListener('click', async () => {
    const logout = $('#logout');
    setBusy(logout, true);
    try {
      await api('/api/auth/logout', { method: 'POST' });
      state.authenticated = false;
      state.user = null;
      closeDialogElement(authDialog);
      renderAccount();
      showToast('You are signed out.', 'success');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      setBusy(logout, false);
    }
  });
  $('#preview-close').addEventListener('click', () => closeDialogElement(previewDialog));
  previewDialog.addEventListener('click', (event) => { if (event.target === previewDialog) closeDialogElement(previewDialog); });
  setAuthMode('login');
  renderAccount();

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
    renderFiles(visibleFiles());
  });
  $('#file-filter').addEventListener('change', () => { if (state.dashboard) renderFiles(visibleFiles()); });
  window.addEventListener('online', load);
  load();
})();
