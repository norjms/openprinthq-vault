/* ─── API Client ──────────────────────────────────────────────────────── */
const API = {
  async request(url, options = {}) {
    // No credential is attached here. The edge authenticates the request
    // before it arrives, so there is no token to hold and no CSRF token to
    // echo: there is no ambient cookie an attacking page could ride.
    const headers = { 'Content-Type': 'application/json', ...options.headers };

    const res = await fetch(url, {
      credentials: 'same-origin',
      headers,
      ...options,
    });
    if (res.status === 401) {
      // The edge session has expired. Reloading sends the browser back through
      // it, which is the only thing that can put the session back.
      window.location.reload();
      return null;
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(err.error || 'Request failed');
    }
    return res.json();
  },

  // Auth
  getMe() { return this.request('/api/auth/me'); },
  updateProfile(data) {
    return this.request('/api/auth/profile', { method: 'PUT', body: JSON.stringify(data) });
  },
  getUsers() { return this.request('/api/users'); },

  // Settings
  getSystemSettings() { return this.request('/api/settings/system'); },
  saveSystemSettings(data) { return this.request('/api/settings/system', { method: 'POST', body: JSON.stringify(data) }); },
  getViewMode() { return this.request('/api/settings/view-mode'); },

  // Library browser
  browseLibrary(browsePath = '') {
    const qs = browsePath ? `?path=${encodeURIComponent(browsePath)}` : '';
    return this.request(`/api/browse${qs}`);
  },
  searchLibrary(q) {
    return this.request(`/api/browse/search?q=${encodeURIComponent(q)}`);
  },
  getFolderTree() { return this.request('/api/browse/tree'); },
  moveItem(source, target) { return this.request('/api/browse/move', { method: 'POST', body: JSON.stringify({ source, target }) }); },
  createFolder(parentPath, folderName) { return this.request('/api/browse/mkdir', { method: 'POST', body: JSON.stringify({ parentPath, folderName }) }); },
  bulkMoveItems(paths, target) { return this.request('/api/browse/bulk-move', { method: 'POST', body: JSON.stringify({ paths, target }) }); },
  bulkDeleteItems(paths) { return this.request('/api/browse/bulk-delete', { method: 'POST', body: JSON.stringify({ paths }) }); },
  bulkTagItems(paths, tags) { return this.request('/api/browse/bulk-tag', { method: 'POST', body: JSON.stringify({ paths, tags }) }); },

  // Models
  getModels(params = {}) {
    const qs = new URLSearchParams(Object.entries(params).filter(([,v]) => v !== '' && v != null)).toString();
    return this.request(`/api/models${qs ? '?' + qs : ''}`);
  },
  getModel(id) { return this.request(`/api/models/${id}`); },
  createModel(data) {
    return this.request('/api/models', { method: 'POST', body: JSON.stringify(data) });
  },
  importModelUrl(url) {
    return this.request('/api/models/import', { method: 'POST', body: JSON.stringify({ url }) });
  },
  updateModel(id, data) {
    return this.request(`/api/models/${id}`, { method: 'PUT', body: JSON.stringify(data) });
  },
  deleteModel(id, deleteDisk = false) {
    return this.request(`/api/models/${id}?deleteDisk=${deleteDisk}`, { method: 'DELETE' });
  },
  createVersion(id, data) {
    return this.request(`/api/models/${id}/versions`, { method: 'POST', body: JSON.stringify(data) });
  },
  bulkDeleteModels(ids, deleteDisk = false) {
    return this.request('/api/models/bulk-delete', { method: 'POST', body: JSON.stringify({ ids, deleteDisk }) });
  },
  bulkUpdateModels(ids, data) {
    return this.request('/api/models/bulk-update', { method: 'POST', body: JSON.stringify({ ids, ...data }) });
  },

  // Files
  uploadFiles(modelId, files, options = {}, onProgress = null) {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      for (const f of files) form.append('files', f);
      if (options.parent_folder) form.append('parent_folder', options.parent_folder);
      if (options.create_subfolder !== undefined) form.append('create_subfolder', options.create_subfolder);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/models/${modelId}/files`);
      xhr.withCredentials = true;

      const startTime = Date.now();
      if (xhr.upload && typeof onProgress === 'function') {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const percent = Math.min(99, Math.round((e.loaded / e.total) * 100));
            const elapsed = Math.max(0.1, (Date.now() - startTime) / 1000);
            const speed = e.loaded / elapsed; // bytes/sec
            const remaining = Math.max(0, e.total - e.loaded);
            const etaSec = speed > 0 ? Math.round(remaining / speed) : 0;
            
            onProgress({
              percent,
              loaded: e.loaded,
              total: e.total,
              speed,
              etaSec
            });
          }
        };
      }

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch (err) {
            resolve(xhr.responseText);
          }
        } else {
          let errMessage = 'Upload failed';
          try {
            const res = JSON.parse(xhr.responseText);
            if (res.error) errMessage = res.error;
          } catch (e) {}
          reject(new Error(errMessage));
        }
      };

      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.send(form);
    });
  },
  async uploadThumbnail(modelId, file) {
    const form = new FormData();
    form.append('thumbnail', file);
    const res = await fetch(`/api/models/${modelId}/thumbnail`, { method: 'POST', body: form, credentials: 'same-origin' });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Upload failed'); }
    return res.json();
  },
  setPreviewFile(modelId, fileId) {
    return this.request(`/api/models/${modelId}/preview-file`, {
      method: 'PUT',
      body: JSON.stringify({ file_id: fileId })
    });
  },
  deleteFile(id, deleteDisk = false) { 
    return this.request(`/api/files/${id}?deleteDisk=${deleteDisk}`, { method: 'DELETE' }); 
  },

  sendToPrinter(id, printerId) {
    return this.request(`/api/files/${id}/send-to-printer`, { method: 'POST', body: JSON.stringify({ printer_id: printerId }) });
  },

  // Prints
  addPrint(modelId, data) {
    return this.request(`/api/models/${modelId}/prints`, { method: 'POST', body: JSON.stringify(data) });
  },
  deletePrint(id) { return this.request(`/api/prints/${id}`, { method: 'DELETE' }); },

  // Categories, Tags, Materials
  getCategories() { return this.request('/api/categories'); },
  createCategory(data) { return this.request('/api/categories', { method: 'POST', body: JSON.stringify(data) }); },
  updateCategory(id, data) { return this.request(`/api/categories/${id}`, { method: 'PUT', body: JSON.stringify(data) }); },
  deleteCategory(id) { return this.request(`/api/categories/${id}`, { method: 'DELETE' }); },

  getTags() { return this.request('/api/tags'); },
  createTag(data) { return this.request('/api/tags', { method: 'POST', body: JSON.stringify(data) }); },
  deleteTag(id) { return this.request(`/api/tags/${id}`, { method: 'DELETE' }); },

  getMaterials() { return this.request('/api/materials'); },
  createMaterial(data) { return this.request('/api/materials', { method: 'POST', body: JSON.stringify(data) }); },
  deleteMaterial(id) { return this.request(`/api/materials/${id}`, { method: 'DELETE' }); },

  // Projects
  getProjects() { return this.request('/api/projects'); },
  getProject(id) { return this.request(`/api/projects/${id}`); },
  createProject(data) { return this.request('/api/projects', { method: 'POST', body: JSON.stringify(data) }); },
  deleteProject(id) { return this.request(`/api/projects/${id}`, { method: 'DELETE' }); },
  addModelToProject(projectId, modelId) { return this.request(`/api/projects/${projectId}/models`, { method: 'POST', body: JSON.stringify({ model_id: modelId }) }); },
  bulkAddModelsToProject(projectId, modelIds) { return this.request(`/api/projects/${projectId}/models/bulk`, { method: 'POST', body: JSON.stringify({ model_ids: modelIds }) }); },
  removeModelFromProject(projectId, modelId) { return this.request(`/api/projects/${projectId}/models/${modelId}`, { method: 'DELETE' }); },

  // Sharing
  createShare(modelId, expiresDays) { return this.request('/api/shares', { method: 'POST', body: JSON.stringify({ model_id: modelId, expires_days: expiresDays }) }); },
  getSharedModel(slug) { return this.request(`/api/shares/${slug}`); },

  // Stats & System
  getStats() { return this.request('/api/stats'); },
  getUpdateStatus() { return this.request('/api/system/updates'); },
  getSystemLogs() { return this.request('/api/system/logs'); },
  clearSystemLogs() { return this.request('/api/system/logs', { method: 'DELETE' }); },
  scanDuplicates() { return this.request('/api/system/duplicates'); }
};
