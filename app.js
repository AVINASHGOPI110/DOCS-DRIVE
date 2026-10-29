(() => {
  "use strict";

  const ACCOUNT_LIMIT = 1024 * 1024 * 1024;
  const FILE_LIMIT = 100 * 1024 * 1024;
  const fileInput = document.getElementById("file-input");
  const fileArea = document.getElementById("file-area");
  const searchInput = document.getElementById("search");
  const toastEl = document.getElementById("toast");
  const homePage = document.getElementById("home-page");
  const authScreen = document.getElementById("auth-screen");
  const dashboard = document.getElementById("dashboard");
  const authForm = document.getElementById("auth-form");
  const authNotice = document.getElementById("auth-notice");
  const connectionNotice = document.getElementById("connection-notice");
  const connectionMessage = document.getElementById("connection-message");
  const usernameInput = document.getElementById("username-input");
  const passwordInput = document.getElementById("password-input");
  const confirmInput = document.getElementById("confirm-input");
  const confirmField = document.getElementById("confirm-field");
  const authSubmit = document.getElementById("auth-submit");
  const authSwitch = document.getElementById("auth-switch");
  let allFiles = [];
  let activeFilter = "all";
  let listView = false;
  let toastTimer;
  let authMode = "login";

  const showPage = (page) => {
    homePage.hidden = page !== "home";
    authScreen.hidden = page !== "auth";
    dashboard.hidden = page !== "dashboard";
    window.scrollTo(0, 0);
  };
  document.querySelectorAll("[data-show-home]").forEach((el) => el.addEventListener("click", (event) => {
    event.preventDefault();
    showPage("home");
  }));
  document.querySelectorAll("[data-show-auth]").forEach((el) => el.addEventListener("click", (event) => {
    event.preventDefault();
    showPage("auth");
  }));

  const api = async (url, options = {}) => {
    const headers = Object.assign({}, options.headers || {});
    if (typeof options.body === "string" && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await fetch(url, Object.assign({}, options, { headers, credentials: "same-origin", cache: "no-store" }));
    } catch {
      throw new Error("The Docs Drive server cannot be reached. Start it with Start Docs Drive.cmd, then refresh this page.");
    }
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok) throw new Error(data.error || "The server could not complete that request.");
    return data;
  };
  const reportConnectionProblem = (message) => {
    connectionMessage.textContent = message;
    connectionNotice.hidden = false;
  };
  const setAuthMode = (mode) => {
    authMode = mode;
    const registering = mode === "register";
    document.getElementById("login-heading").textContent = registering ? "Create your space." : "Welcome back.";
    document.querySelector(".auth-lead").textContent = registering
      ? "Choose a username and password to create your private file space."
      : "Sign in to pick up your photos, videos, and files wherever you are.";
    confirmField.hidden = !registering;
    confirmInput.required = registering;
    confirmInput.value = "";
    document.getElementById("auth-row").hidden = registering;
    authSubmit.textContent = registering ? "Create account" : "Log in";
    document.querySelector(".auth-divider span").textContent = registering ? "ALREADY HAVE AN ACCOUNT?" : "NEW TO DOCS DRIVE?";
    document.getElementById("auth-switch-line").textContent = registering ? "Already registered with Docs Drive?" : "New to Docs Drive?";
    authSwitch.textContent = registering ? "Log in" : "Create an account";
    passwordInput.autocomplete = registering ? "new-password" : "current-password";
    passwordInput.minLength = registering ? 12 : 1;
    authNotice.textContent = "";
  };
  authSwitch.addEventListener("click", () => setAuthMode(authMode === "login" ? "register" : "login"));
  authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    authNotice.textContent = "";
    if (authMode === "register" && passwordInput.value !== confirmInput.value) {
      authNotice.textContent = "The passwords do not match.";
      confirmInput.focus();
      return;
    }
    authSubmit.disabled = true;
    authSubmit.textContent = authMode === "register" ? "Creating account..." : "Signing in...";
    try {
      const result = await api(authMode === "register" ? "/api/auth/register" : "/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          username: usernameInput.value,
          password: passwordInput.value,
          remember: document.getElementById("remember-me").checked
        })
      });
      passwordInput.value = "";
      confirmInput.value = "";
      document.getElementById("remember-me").checked = false;
      connectionNotice.hidden = true;
      await enterWorkspace(result.user);
    } catch (error) {
      authNotice.textContent = error.message;
    } finally {
      authSubmit.disabled = false;
      authSubmit.textContent = authMode === "register" ? "Create account" : "Log in";
    }
  });
  document.getElementById("show-password").addEventListener("click", (event) => {
    const showing = passwordInput.type === "text";
    passwordInput.type = showing ? "password" : "text";
    event.currentTarget.textContent = showing ? "Show" : "Hide";
    event.currentTarget.setAttribute("aria-label", showing ? "Show password" : "Hide password");
  });
  document.getElementById("forgot-password").addEventListener("click", () => {
    authNotice.textContent = "Password reset is not available yet. Contact the site administrator if you lose access.";
  });
  document.getElementById("sign-out").addEventListener("click", async () => {
    try { await api("/api/auth/logout", { method: "POST" }); } catch {}
    allFiles = [];
    setAuthMode("login");
    showPage("auth");
  });

  const svg = (name) => '<svg class="icon" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
  const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const bytes = (n) => {
    if (!n) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const ix = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
    const value = n / Math.pow(1024, ix);
    return (value >= 100 || ix === 0 ? Math.round(value) : value.toFixed(1)) + " " + units[ix];
  };
  const fmtDate = (value) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
  const notify = (message) => {
    toastEl.textContent = message;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 3200);
  };
  const updateUsage = () => {
    const used = allFiles.reduce((sum, file) => sum + Number(file.size), 0);
    const percentage = Math.min(100, (used / ACCOUNT_LIMIT) * 100);
    document.getElementById("side-usage").textContent = bytes(used);
    document.getElementById("side-remaining").textContent = bytes(Math.max(0, ACCOUNT_LIMIT - used));
    document.getElementById("side-meter").style.width = percentage + "%";
    document.getElementById("stat-used").innerHTML = esc(bytes(used)) + ' <span>of 1 GB</span>';
    document.getElementById("stat-files").textContent = allFiles.length;
    document.getElementById("nav-all").textContent = allFiles.length;
  };
  const iconFor = (kind) => kind === "image" ? "image" : kind === "video" ? "video" : kind === "audio" ? "music" : "file";
  const previewHtml = (file) => {
    if (file.category === "image") return '<img alt="" loading="lazy" src="/api/files/' + encodeURIComponent(file.id) + '/preview">';
    return svg(iconFor(file.category));
  };
  const filteredFiles = () => {
    const term = searchInput.value.trim().toLowerCase();
    return allFiles.filter((file) => {
      const categoryMatch = activeFilter === "all" || (activeFilter === "starred" ? !!file.starred : file.category === activeFilter);
      const searchMatch = !term || file.name.toLowerCase().includes(term);
      return categoryMatch && searchMatch;
    });
  };
  const refresh = async () => {
    const result = await api("/api/files");
    allFiles = result.files || [];
    updateUsage();
    render();
  };
  const render = () => {
    document.querySelectorAll(".nav-btn, .filter").forEach((button) => button.classList.toggle("active", button.dataset.filter === activeFilter));
    const results = filteredFiles();
    const titleMap = { all: "Your files", image: "Photos", video: "Videos", document: "Documents", audio: "Audio", other: "Other files", starred: "Starred" };
    document.getElementById("section-title").textContent = titleMap[activeFilter] || "Your files";
    document.getElementById("crumb-label").textContent = titleMap[activeFilter] || "All files";
    document.getElementById("section-sub").textContent = results.length ? results.length + (results.length === 1 ? " file in this view" : " files in this view") : "Everything you add, all in one place";
    if (!results.length) {
      const hasAny = allFiles.length > 0;
      fileArea.innerHTML = '<div class="empty"><div class="empty-art">' + svg(hasAny ? "search" : "cloud") + '</div><h3>' + (hasAny ? "No files found" : "Nothing here just yet") + '</h3><p>' + (hasAny ? "Try a different name or choose another filter." : "Add a photo, a video, or any file you want to keep close.") + '</p>' + (hasAny ? "" : '<button class="upload-small" id="empty-upload" type="button">' + svg("plus") + "Add your first file</button>") + '</div>';
      const emptyUpload = document.getElementById("empty-upload");
      if (emptyUpload) emptyUpload.addEventListener("click", () => fileInput.click());
      return;
    }
    const cards = results.map((file) => {
      return '<article class="file-card" data-id="' + esc(file.id) + '">' +
        '<div class="file-preview">' + previewHtml(file) + '</div>' +
        '<div class="file-info"><div class="kind-icon ' + esc(file.category) + '">' + svg(iconFor(file.category)) + '</div>' +
        '<div class="file-name-wrap"><div class="file-name" title="' + esc(file.name) + '">' + esc(file.name) + '</div><div class="file-meta">' + bytes(file.size) + ' - ' + fmtDate(file.createdAt) + '</div></div>' +
        '<div class="card-actions"><button class="tiny-btn star ' + (file.starred ? "starred" : "") + '" type="button" title="' + (file.starred ? "Remove star" : "Star file") + '" aria-label="' + (file.starred ? "Remove star from " : "Star ") + esc(file.name) + '">' + svg("star") + '</button><button class="tiny-btn download" type="button" title="Download ' + esc(file.name) + '" aria-label="Download ' + esc(file.name) + '">' + svg("download") + '</button><button class="tiny-btn delete" type="button" title="Remove ' + esc(file.name) + '" aria-label="Remove ' + esc(file.name) + '">' + svg("trash") + '</button></div></div></article>';
    }).join("");
    fileArea.innerHTML = '<div class="file-grid ' + (listView ? "file-list" : "") + '">' + cards + '</div>';
    fileArea.querySelectorAll(".download").forEach((button) => button.addEventListener("click", (event) => downloadFile(event.currentTarget.closest(".file-card").dataset.id)));
    fileArea.querySelectorAll(".delete").forEach((button) => button.addEventListener("click", (event) => removeFile(event.currentTarget.closest(".file-card").dataset.id)));
    fileArea.querySelectorAll(".star").forEach((button) => button.addEventListener("click", (event) => toggleStar(event.currentTarget.closest(".file-card").dataset.id)));
  };
  const enterWorkspace = async (user) => {
    document.getElementById("account-username").textContent = user.username;
    document.getElementById("account-avatar").textContent = user.username.slice(0, 2).toUpperCase();
    document.getElementById("account-avatar").setAttribute("aria-label", "Signed in as " + user.username);
    showPage("dashboard");
    try {
      await refresh();
    } catch (error) {
      notify(error.message);
      if (error.message === "Please sign in again.") showPage("auth");
    }
  };
  const downloadFile = (id) => {
    const link = document.createElement("a");
    link.href = "/api/files/" + encodeURIComponent(id) + "/download";
    link.download = "";
    document.body.append(link);
    link.click();
    link.remove();
  };
  const removeFile = async (id) => {
    const file = allFiles.find((entry) => entry.id === id);
    if (!file || !window.confirm('Remove "' + file.name + '" from your Docs Drive account?')) return;
    try {
      await api("/api/files/" + encodeURIComponent(id), { method: "DELETE" });
      await refresh();
      notify("Removed " + file.name);
    } catch (error) {
      notify(error.message);
    }
  };
  const toggleStar = async (id) => {
    const file = allFiles.find((entry) => entry.id === id);
    if (!file) return;
    try {
      await api("/api/files/" + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify({ starred: !file.starred }) });
      await refresh();
      notify(file.starred ? "Removed from Starred" : "Added to Starred");
    } catch (error) {
      notify(error.message);
    }
  };
  const saveFiles = async (files) => {
    let used = allFiles.reduce((sum, file) => sum + Number(file.size), 0);
    let saved = 0;
    for (const file of files) {
      if (file.size >= FILE_LIMIT) {
        notify(file.name + " must be smaller than 100 MB.");
        continue;
      }
      if (used + file.size > ACCOUNT_LIMIT) {
        notify("There is not enough room for " + file.name + ". The 1 GB account limit is full.");
        continue;
      }
      try {
        await api("/api/files", {
          method: "POST",
          headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) },
          body: file
        });
        used += file.size;
        saved += 1;
      } catch (error) {
        notify(error.message);
      }
    }
    await refresh();
    if (saved === 1) notify("File added to your account.");
    else if (saved > 1) notify(saved + " files added to your account.");
  };

  document.getElementById("top-upload").addEventListener("click", () => fileInput.click());
  document.getElementById("browse-link").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (event) => { if (event.target.files && event.target.files.length) saveFiles(Array.from(event.target.files)); event.target.value = ""; });
  searchInput.addEventListener("input", render);
  document.getElementById("view-toggle").addEventListener("click", (event) => {
    listView = !listView;
    event.currentTarget.innerHTML = svg(listView ? "grid" : "list");
    event.currentTarget.setAttribute("aria-label", listView ? "Switch to grid view" : "Switch to list view");
    render();
  });
  document.querySelectorAll(".nav-btn, .filter").forEach((button) => button.addEventListener("click", () => {
    activeFilter = button.dataset.filter;
    render();
  }));
  const dropzone = document.getElementById("dropzone");
  ["dragenter", "dragover"].forEach((name) => dropzone.addEventListener(name, (event) => { event.preventDefault(); dropzone.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((name) => dropzone.addEventListener(name, (event) => { event.preventDefault(); dropzone.classList.remove("drag"); }));
  dropzone.addEventListener("drop", (event) => { if (event.dataTransfer && event.dataTransfer.files.length) saveFiles(Array.from(event.dataTransfer.files)); });
  document.addEventListener("dragover", (event) => event.preventDefault());
  document.addEventListener("drop", (event) => event.preventDefault());

  api("/api/auth/me").then((result) => {
    connectionNotice.hidden = true;
    if (result.user) enterWorkspace(result.user);
  }).catch((error) => reportConnectionProblem(error.message));
})();
