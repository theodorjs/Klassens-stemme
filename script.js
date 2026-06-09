import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-app.js";
import {
    getFirestore, doc, setDoc, getDoc, addDoc, updateDoc, deleteDoc,
    collection, getDocs, onSnapshot, query, where, increment
} from "https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js";
import { getStorage, ref as sRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-storage.js";

const firebaseConfig = {
    apiKey: "AIzaSyDFb5GK8bUZP2ZpMByG9-X1JiL-jNPFrKY",
    authDomain: "klassens-stemme.firebaseapp.com",
    projectId: "klassens-stemme",
    storageBucket: "klassens-stemme.firebasestorage.app",
    messagingSenderId: "607973299678",
    appId: "1:607973299678:web:250efdd7104d32c050394f"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const storage = getStorage(app);

// ============================
// LOCAL STORAGE HELPERS
// ============================

const LS = {
    get(key) {
        try { const v = localStorage.getItem('ks_' + key); return v !== null ? JSON.parse(v) : null; }
        catch { return null; }
    },
    set(key, value) {
        try { localStorage.setItem('ks_' + key, JSON.stringify(value)); } catch {}
    }
};

// ============================
// GLOBAL STATE
// ============================

let currentSessionId = null;
let myVotedSessions = {};
// True after user has manually toggled theme — prevents Firebase from overriding
let studentThemeOverridden = false;
let chartInstance = null;
let tournamentChartInstance = null;
// TMDB key hardcoded as default, overridable via settings
let tmdbApiKey = "ab2d6aeb4bb7d48768a7b5a95873613c";
let moviePool = [];
let tournamentGroupSize = 4; // adjustable 2–5
let currentTournamentId = null;
let currentTournamentData = null;
let dbListenersAttached = false;
let unsubscribeMoviePool = null;
let unsubscribeTmdbKey = null;
let unsubscribeHistory = null;
let tournamentUnsubscribe = null;
let adminChartUnsubscribe = null;          // admin: session chart listener inside tournament
let studentTournamentUnsubscribe = null;   // student: outer tournament doc listener
let studentSessionUnsubscribe = null;      // student: inner session doc listener
let studentListeningSessionId = null;      // avoids re-subscribing to the same session
let questionImgFile = null;

const views = {
    landing: document.getElementById('landing-page'),
    admin: document.getElementById('admin-dashboard'),
    student: document.getElementById('student-view')
};

// ============================
// HELPERS: options stored as map in Firestore, displayed as array
// ============================

// ============================
// COLOR HELPERS
// ============================

function hexToRgba(hex, alpha) {
    if (!hex || !hex.startsWith('#') || hex.length < 7) return `rgba(94,231,223,${alpha})`;
    const r = parseInt(hex.slice(1,3), 16);
    const g = parseInt(hex.slice(3,5), 16);
    const b = parseInt(hex.slice(5,7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

function isDarkColor(hex) {
    if (!hex || !hex.startsWith('#') || hex.length < 7) return false;
    const r = parseInt(hex.slice(1,3), 16);
    const g = parseInt(hex.slice(3,5), 16);
    const b = parseInt(hex.slice(5,7), 16);
    return (0.299*r + 0.587*g + 0.114*b) / 255 < 0.35;
}

function optionsToMap(arr) {
    const map = {};
    arr.forEach((opt, i) => { map[String(i)] = opt; });
    return map;
}

function optionsToArray(mapOrArr) {
    if (Array.isArray(mapOrArr)) return mapOrArr;
    return Object.keys(mapOrArr || {}).sort((a, b) => +a - +b).map(k => mapOrArr[k]);
}

// ============================
// GLOBAL SETTINGS (localStorage primary, Firestore secondary)
// ============================

// Apply saved settings immediately from localStorage (no flicker on load)
(function applyLocalSettings() {
    const dark = LS.get('darkMode');
    // Dark is the default (no attribute). Only set light if explicitly saved.
    if (dark === false) document.documentElement.setAttribute('data-theme', 'light');
    const bgUrl = LS.get('backgroundUrl');
    if (bgUrl) document.getElementById('app-background').style.backgroundImage = `url('${bgUrl}')`;
    const savedKey = LS.get('tmdb_api_key');
    if (savedKey) tmdbApiKey = savedKey;
})();

// Sync settings from Firestore (single document for all app settings)
onSnapshot(doc(db, 'settings', 'app'), (snap) => {
    if (!snap.exists()) return;
    const data = snap.data();
    if (data.darkMode !== undefined) {
        const isDark = !!data.darkMode;
        // Only sync from Firebase if the user hasn't manually overridden the theme
        if (!studentThemeOverridden) {
            if (isDark) {
                document.documentElement.removeAttribute('data-theme');
            } else {
                document.documentElement.setAttribute('data-theme', 'light');
            }
        }
        LS.set('darkMode', isDark);
        updateThemeIcon();
    }
    if (data.backgroundUrl) {
        document.getElementById('app-background').style.backgroundImage = `url('${data.backgroundUrl}')`;
        LS.set('backgroundUrl', data.backgroundUrl);
    }
    if (data.tmdb_api_key) {
        tmdbApiKey = data.tmdb_api_key;
        LS.set('tmdb_api_key', data.tmdb_api_key);
        const input = document.getElementById('tmdb-key-input');
        if (input && document.activeElement !== input) input.value = data.tmdb_api_key;
    }
});

function updateThemeIcon() {
    const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    btn.querySelector('.material-icons-round').textContent = isDark ? 'light_mode' : 'dark_mode';
    btn.querySelector('.label').textContent = isDark ? 'Lys modus' : 'Mørk modus';
}

async function saveSetting(key, value) {
    LS.set(key, value);
    try {
        await setDoc(doc(db, 'settings', 'app'), { [key]: value }, { merge: true });
    } catch (e) { console.warn('Firestore settings write failed:', e); }
}

// ============================
// AUTH
// ============================

let pendingCode = null;
const urlParams = new URLSearchParams(window.location.search);
const urlCode = urlParams.get('code');
if (urlCode) {
    document.getElementById('session-code-input').value = urlCode;
    pendingCode = urlCode;
}

onAuthStateChanged(auth, (user) => {
    const loginBtn = document.getElementById('admin-login-btn');
    const logoutBtn = document.getElementById('logout-btn');
    const bgLabel = document.getElementById('bg-upload-label');
    const adminDivider = document.getElementById('admin-menu-divider');
    const tmdbGroup = document.getElementById('tmdb-key-group');

    if (user) {
        showView('admin');
        loginBtn.classList.add('hidden');
        logoutBtn.classList.remove('hidden');
        if (bgLabel) bgLabel.style.display = '';
        if (adminDivider) adminDivider.style.display = '';
        if (tmdbGroup) tmdbGroup.style.display = '';
        if (!dbListenersAttached) {
            attachDatabaseListeners();
            dbListenersAttached = true;
        }
        // Show saved TMDB key in input
        const input = document.getElementById('tmdb-key-input');
        if (input) input.value = tmdbApiKey !== "ab2d6aeb4bb7d48768a7b5a95873613c" ? tmdbApiKey : (LS.get('tmdb_api_key') || "");
        // Ensure creation form starts with 2 default options
        if (document.getElementById('options-container').children.length === 0) {
            createOptionRow();
            createOptionRow();
        }
    } else {
        showView('landing');
        if (pendingCode) { joinSession(pendingCode); pendingCode = null; }
        loginBtn.classList.remove('hidden');
        logoutBtn.classList.add('hidden');
        if (bgLabel) bgLabel.style.display = 'none';
        if (adminDivider) adminDivider.style.display = 'none';
        if (tmdbGroup) tmdbGroup.style.display = 'none';
        detachDatabaseListeners();
        dbListenersAttached = false;
    }
});

document.getElementById('admin-login-btn').onclick = () =>
    document.getElementById('login-modal').classList.remove('hidden');

document.getElementById('login-form').onsubmit = (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value;
    const pwd = document.getElementById('current-password').value;
    signInWithEmailAndPassword(auth, email, pwd)
        .then(() => {
            document.getElementById('login-modal').classList.add('hidden');
            document.getElementById('login-form').reset();
        })
        .catch(err => alert("Kunne ikke logge inn: " + err.message));
};

const loginModal = document.getElementById('login-modal');
loginModal.querySelector('.close').onclick = () => loginModal.classList.add('hidden');
loginModal.onclick = (e) => { if (e.target === loginModal) loginModal.classList.add('hidden'); };

document.getElementById('logout-btn').onclick = () =>
    signOut(auth).catch(err => alert("Logg ut feilet: " + err.message));

// ============================
// THEME & UI
// ============================

const moreMenuBtn = document.getElementById('more-menu-btn');
const moreDropdown = document.getElementById('more-dropdown');

moreMenuBtn.onclick = (e) => {
    e.stopPropagation();
    moreDropdown.classList.toggle('hidden');
};

document.addEventListener('click', (e) => {
    if (!moreDropdown.classList.contains('hidden') &&
        !moreDropdown.contains(e.target) && e.target !== moreMenuBtn) {
        moreDropdown.classList.add('hidden');
    }
});

document.getElementById('theme-toggle').onclick = () => {
    studentThemeOverridden = true; // User is manually choosing — don't let Firebase override
    // Toggle: dark (no attribute) ↔ light (data-theme="light")
    const currentlyDark = document.documentElement.getAttribute('data-theme') !== 'light';
    const newIsDark = !currentlyDark;
    if (newIsDark) {
        document.documentElement.removeAttribute('data-theme');
    } else {
        document.documentElement.setAttribute('data-theme', 'light');
    }
    updateThemeIcon();
    saveSetting('darkMode', newIsDark);
};

document.getElementById('bg-upload-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        const dataUrl = ev.target.result;
        document.getElementById('app-background').style.backgroundImage = `url('${dataUrl}')`;
        LS.set('backgroundUrl', dataUrl);
    };
    reader.readAsDataURL(file);
    try {
        const storageRef = sRef(storage, 'backgrounds/' + Date.now());
        await uploadBytes(storageRef, file);
        const url = await getDownloadURL(storageRef);
        document.getElementById('app-background').style.backgroundImage = `url('${url}')`;
        saveSetting('backgroundUrl', url);
    } catch (err) {
        console.warn("Storage upload failed, using local preview:", err);
    }
});

// ============================
// DB LISTENERS (admin only)
// ============================

function attachDatabaseListeners() {
    // TMDB key from local first
    const localKey = LS.get('tmdb_api_key');
    if (localKey) {
        tmdbApiKey = localKey;
        const input = document.getElementById('tmdb-key-input');
        if (input) input.value = localKey;
    }

    // Movie pool
    unsubscribeMoviePool = onSnapshot(doc(db, 'movie_pool', 'items'), (snap) => {
        moviePool = snap.exists() ? (snap.data().movies || []) : [];
        renderMoviePool();
    });

    loadHistory();
}

function detachDatabaseListeners() {
    if (unsubscribeMoviePool) { unsubscribeMoviePool(); unsubscribeMoviePool = null; }
    if (unsubscribeHistory) { unsubscribeHistory(); unsubscribeHistory = null; }
}

// TMDB key input — save to Firestore and localStorage
const tmdbKeyInput = document.getElementById('tmdb-key-input');
let tmdbKeyTimer = null;

function saveTmdbKey(value) {
    const key = value.trim();
    tmdbApiKey = key || "ab2d6aeb4bb7d48768a7b5a95873613c";
    LS.set('tmdb_api_key', key);
    saveSetting('tmdb_api_key', key);
}

tmdbKeyInput.addEventListener('input', (e) => {
    clearTimeout(tmdbKeyTimer);
    tmdbKeyTimer = setTimeout(() => saveTmdbKey(e.target.value), 800);
});
tmdbKeyInput.addEventListener('blur', (e) => {
    clearTimeout(tmdbKeyTimer);
    saveTmdbKey(e.target.value);
});

// ============================
// SHOW VIEW
// ============================

function showView(name) {
    Object.values(views).forEach(el => el.classList.add('hidden'));
    views[name].classList.remove('hidden');
    document.body.setAttribute('data-view', name);
    // Clean up all student-side listeners and state when leaving student view
    if (name !== 'student') {
        const wo = document.getElementById('winner-overlay');
        if (wo) wo.classList.add('hidden');
        winnerShown = false;
        if (studentTournamentUnsubscribe) { studentTournamentUnsubscribe(); studentTournamentUnsubscribe = null; }
        if (studentSessionUnsubscribe)    { studentSessionUnsubscribe();    studentSessionUnsubscribe = null; }
        studentListeningSessionId = null;
    }
}

// ============================
// STYLE PANEL
// ============================

window.toggleStylePanel = (id) => {
    const body = document.getElementById(id);
    if (!body) return;
    const collapsed = body.classList.toggle('collapsed');
    const icon = body.previousElementSibling?.querySelector('.toggle-icon');
    if (icon) icon.textContent = collapsed ? 'expand_more' : 'expand_less';
};

window.toggleStyleBtn = (btn) => btn.classList.toggle('active');

function getQuestionStyle() {
    return {
        fontFamily: document.getElementById('q-font-family').value,
        fontSize: parseInt(document.getElementById('q-font-size').value) || 32,
        bold: document.getElementById('q-bold').classList.contains('active'),
        italic: document.getElementById('q-italic').classList.contains('active'),
        textColor: document.getElementById('q-text-color').value
    };
}

function getOptionsStyle() {
    return {
        fontFamily: document.getElementById('opt-font-family').value,
        fontSize: parseInt(document.getElementById('opt-font-size').value) || 18,
        bold: document.getElementById('opt-bold').classList.contains('active'),
        italic: document.getElementById('opt-italic').classList.contains('active')
    };
}

function applyTextStyle(el, style) {
    if (!style) return;
    if (style.fontFamily && style.fontFamily !== 'inherit') el.style.fontFamily = style.fontFamily;
    if (style.fontSize) el.style.fontSize = style.fontSize + 'px';
    el.style.fontWeight = style.bold ? 'bold' : '';
    el.style.fontStyle = style.italic ? 'italic' : '';
    if (style.textColor) {
        // In dark mode, don't apply colours that are too dark to be readable
        const inDarkMode = document.documentElement.getAttribute('data-theme') !== 'light';
        if (!inDarkMode || !isDarkColor(style.textColor)) {
            el.style.color = style.textColor;
        }
    }
}

// Question image
document.getElementById('question-img-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    const preview = document.getElementById('question-img-preview');
    if (file) {
        questionImgFile = file;
        const reader = new FileReader();
        reader.onload = (ev) => {
            preview.style.backgroundImage = `url('${ev.target.result}')`;
            preview.classList.remove('hidden');
        };
        reader.readAsDataURL(file);
    } else {
        questionImgFile = null;
        preview.classList.add('hidden');
    }
});

// ============================
// ADMIN: CREATION
// ============================

const AUTO_OPT_COLORS = ['#5ee7df','#b490f5','#f87171','#ffd27f','#a8f08a','#f7a8c4'];

// Chart type visual picker
function getSelectedChartType() {
    const active = document.querySelector('.chart-type-btn.active');
    return active ? active.dataset.type : 'bar';
}

document.querySelectorAll('.chart-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.chart-type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    });
});

function createOptionRow(text = "", color = null, imgUrl = "", textColor = "#ffffff") {
    const container = document.getElementById('options-container');
    if (!color) {
        const count = container.querySelectorAll('.option-row-wrapper').length;
        color = AUTO_OPT_COLORS[count % AUTO_OPT_COLORS.length];
    }
    const div = document.createElement('div');
    div.className = 'option-row-wrapper';
    if (imgUrl) div.dataset.tmdbImgUrl = imgUrl;

    div.innerHTML = `
        <div class="option-row">
            <div class="opt-preview" style="border-color:${color};${imgUrl ? `background-image:url('${imgUrl}');` : ''}"></div>
            <input type="text" placeholder="Svaralternativ" class="opt-text" value="${text}">
            <label class="color-picker-label" title="Kantfarge">
                <input type="color" value="${color}" class="opt-color">
                <span class="material-icons-round">palette</span>
            </label>
            <label class="color-picker-label" title="Tekstfarge">
                <input type="color" value="${textColor}" class="opt-text-color">
                <span class="material-icons-round">format_color_text</span>
            </label>
            <label class="color-picker-label" title="Last opp bilde">
                <input type="file" accept="image/*" class="opt-img-input hidden-input">
                <span class="material-icons-round">image</span>
            </label>
            <button type="button" onclick="this.closest('.option-row-wrapper').remove()" class="icon-btn-danger" title="Fjern">
                <span class="material-icons-round">close</span>
            </button>
        </div>
    `;

    const colorInput = div.querySelector('.opt-color');
    const fileInput = div.querySelector('.opt-img-input');
    const preview = div.querySelector('.opt-preview');

    colorInput.addEventListener('input', (e) => { preview.style.borderColor = e.target.value; });
    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            delete div.dataset.tmdbImgUrl;
            const reader = new FileReader();
            reader.onload = (ev) => { preview.style.backgroundImage = `url('${ev.target.result}')`; };
            reader.readAsDataURL(file);
        } else {
            preview.style.backgroundImage = imgUrl ? `url('${imgUrl}')` : '';
            if (imgUrl) div.dataset.tmdbImgUrl = imgUrl;
        }
    });

    container.appendChild(div);
}

document.getElementById('add-option-btn').onclick = () => createOptionRow();

document.getElementById('launch-poll-btn').onclick = async () => {
    try {
        const question = document.getElementById('question-text').value.trim();
        if (!question) { alert("Skriv inn et spørsmål."); return; }
        const optRows = document.querySelectorAll('.option-row-wrapper');
        if (!optRows.length) { alert("Legg til minst ett svaralternativ."); return; }

        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const questionStyle = getQuestionStyle();
        const optionsStyle = getOptionsStyle();

        let questionImgUrl = "";
        if (questionImgFile) {
            try {
                const imgRef = sRef(storage, `questions/${Date.now()}_${questionImgFile.name}`);
                await uploadBytes(imgRef, questionImgFile);
                questionImgUrl = await getDownloadURL(imgRef);
            } catch (uploadErr) {
                console.warn("Bilde-opplasting til Storage feilet, bruker base64:", uploadErr);
                // Fall back to base64 data URL so the poll can still launch
                questionImgUrl = await new Promise(resolve => {
                    const reader = new FileReader();
                    reader.onload  = ev => resolve(ev.target.result);
                    reader.onerror = ()  => resolve("");
                    reader.readAsDataURL(questionImgFile);
                });
            }
        }

        const optionsArr = [];
        for (const row of optRows) {
            const text = row.querySelector('.opt-text').value;
            const color = row.querySelector('.opt-color').value;
            const textColor = row.querySelector('.opt-text-color').value;
            const fileInput = row.querySelector('.opt-img-input');
            let imgUrl = row.dataset.tmdbImgUrl || "";
            if (!imgUrl && fileInput?.files[0]) {
                const imgRef = sRef(storage, `options/${Date.now()}_${fileInput.files[0].name}`);
                await uploadBytes(imgRef, fileInput.files[0]);
                imgUrl = await getDownloadURL(imgRef);
            }
            optionsArr.push({ text, color, textColor, imgUrl, votes: 0 });
        }

        // Store options as MAP for atomic vote increment in Firestore
        const sessionData = {
            code,
            question,
            questionStyle,
            questionImgUrl,
            optionsStyle,
            options: optionsToMap(optionsArr),
            chartType: getSelectedChartType(),
            maxVotes: parseInt(document.getElementById('max-votes').value) || 1,
            active: true,
            timestamp: Date.now()
        };

        const docRef = await addDoc(collection(db, 'sessions'), sessionData);
        currentSessionId = docRef.id;
        showResultsView(code);
        listenToResults(currentSessionId);
    } catch (err) {
        console.error(err);
        alert("Feil ved start av avstemning: " + err.message);
    }
};

function showResultsView(code) {
    document.getElementById('creation-view').classList.add('hidden');
    document.getElementById('tournament-view').classList.add('hidden');
    document.getElementById('live-results-view').classList.remove('hidden');
    document.getElementById('display-code').innerText = code;
    document.getElementById('qrcode').innerHTML = "";
    new QRCode(document.getElementById('qrcode'), {
        text: `${location.origin}${location.pathname}?code=${code}`,
        width: 100, height: 100
    });
    // Regular polls are always single-round — hide "next round" button
    document.getElementById('next-round-btn').classList.add('hidden');
    document.getElementById('stop-poll-btn').classList.remove('hidden');
}

function initCreationForm() {
    currentSessionId = null;
    document.getElementById('question-text').value = "";
    document.getElementById('options-container').innerHTML = "";
    questionImgFile = null;
    document.getElementById('question-img-preview').classList.add('hidden');
    document.getElementById('question-img-input').value = "";
    ['q-font-family', 'opt-font-family'].forEach(id => document.getElementById(id).value = 'inherit');
    document.getElementById('q-font-size').value = '32';
    document.getElementById('opt-font-size').value = '18';
    document.getElementById('q-text-color').value = '#ffffff';
    ['q-bold', 'q-italic', 'opt-bold', 'opt-italic'].forEach(id => document.getElementById(id).classList.remove('active'));
    // Reset chart type picker to bar
    document.querySelectorAll('.chart-type-btn').forEach(b => b.classList.remove('active'));
    const barBtn = document.querySelector('.chart-type-btn[data-type="bar"]');
    if (barBtn) barBtn.classList.add('active');
    // Pre-fill 2 empty options with auto-colours
    createOptionRow();
    createOptionRow();
}

document.getElementById('create-new-btn').onclick = () => {
    initCreationForm();
    document.getElementById('creation-view').classList.remove('hidden');
    document.getElementById('live-results-view').classList.add('hidden');
    document.getElementById('tournament-view').classList.add('hidden');
};

document.getElementById('stop-poll-btn').onclick = async () => {
    if (currentSessionId) {
        // Fetch live data to find winner before closing
        try {
            const sesSnap = await getDoc(doc(db, 'sessions', currentSessionId));
            if (sesSnap.exists()) {
                const data = sesSnap.data();
                const opts = optionsToArray(data.options);
                const maxVotes = Math.max(...opts.map(o => o.votes || 0), 0);
                if (maxVotes > 0) {
                    const winners = opts.filter(o => (o.votes || 0) === maxVotes);
                    if (winners.length === 1) showPollWinner(winners[0]);
                }
            }
        } catch (e) { console.warn('Could not determine winner:', e); }
        await updateDoc(doc(db, 'sessions', currentSessionId), { active: false }).catch(console.error);
    }
    document.getElementById('creation-view').classList.remove('hidden');
    document.getElementById('live-results-view').classList.add('hidden');
};

document.getElementById('next-round-btn').onclick = async () => {
    if (currentSessionId) {
        await updateDoc(doc(db, 'sessions', currentSessionId), { active: false }).catch(console.error);
    }
    document.getElementById('creation-view').classList.remove('hidden');
    document.getElementById('live-results-view').classList.add('hidden');
};

// ============================
// RESULTS
// ============================

let unsubscribeResults = null;

function listenToResults(sessionId) {
    if (unsubscribeResults) unsubscribeResults();
    unsubscribeResults = onSnapshot(doc(db, 'sessions', sessionId), (snap) => {
        if (!snap.exists()) return;
        const data = { id: snap.id, ...snap.data() };
        renderResultsHeader(data);
        renderChart(data, 'results-chart');
    });
}

function renderResultsHeader(data) {
    const el = document.getElementById('results-question-display');
    if (!el) return;
    el.innerHTML = '';
    if (data.questionImgUrl) {
        const img = document.createElement('img');
        img.src = data.questionImgUrl;
        img.className = 'results-question-img';
        el.appendChild(img);
    }
    const p = document.createElement('p');
    p.textContent = data.question;
    applyTextStyle(p, data.questionStyle);
    el.appendChild(p);
}

function renderChart(data, canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (canvasId === 'results-chart' && chartInstance) { chartInstance.destroy(); chartInstance = null; }
    if (canvasId === 'tournament-chart' && tournamentChartInstance) { tournamentChartInstance.destroy(); tournamentChartInstance = null; }

    const opts = optionsToArray(data.options);
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const textColor  = isLight ? '#0f172a' : '#ffffff';
    const gridColor  = isLight ? 'rgba(15,23,42,0.12)' : 'rgba(255,255,255,0.12)';
    const chartType  = data.chartType || 'bar';
    const isBar = chartType === 'bar';

    const inst = new Chart(canvas.getContext('2d'), {
        type: chartType,
        data: {
            labels: opts.map(o => o.text),
            datasets: [{
                label: '# Stemmer',
                data: opts.map(o => o.votes || 0),
                backgroundColor: opts.map(o => hexToRgba(o.color || '#5ee7df', 0.62)),
                borderColor:     opts.map(o => hexToRgba(o.color || '#5ee7df', 0.90)),
                borderWidth: 2,
                borderRadius: isBar ? 8 : 0,
                hoverBorderWidth: 3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 500, easing: 'easeOutQuart' },
            plugins: {
                legend: {
                    display: !isBar,
                    labels: { color: textColor, font: { family: 'DM Sans', size: 13 }, padding: 16 }
                },
                tooltip: {
                    backgroundColor: isLight ? 'rgba(255,255,255,0.95)' : 'rgba(14,18,40,0.96)',
                    titleColor: textColor, bodyColor: textColor,
                    borderColor: isLight ? 'rgba(15,23,42,0.14)' : 'rgba(255,255,255,0.18)',
                    borderWidth: 1, cornerRadius: 10, padding: 10
                }
            },
            scales: isBar ? {
                x: {
                    ticks: { color: textColor, font: { family: 'DM Sans', size: 13 }, maxRotation: 0 },
                    grid:  { color: gridColor }
                },
                y: {
                    beginAtZero: true,
                    ticks: { color: textColor, font: { family: 'DM Sans', size: 12 }, stepSize: 1 },
                    grid:  { color: gridColor }
                }
            } : {}
        }
    });
    if (canvasId === 'results-chart') chartInstance = inst;
    else tournamentChartInstance = inst;

    // Render poster row below chart
    const posterRowId = canvasId === 'results-chart' ? 'results-poster-row' : 'tournament-poster-row';
    renderPosterRow(opts, posterRowId);
}

function renderPosterRow(opts, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const maxVotes = Math.max(...opts.map(o => o.votes || 0), 0);
    container.innerHTML = opts.map(opt => {
        const isWinner = maxVotes > 0 && (opt.votes || 0) === maxVotes;
        return `
            <div class="chart-poster-item${isWinner ? ' is-winner' : ''}">
                ${opt.imgUrl
                    ? `<img src="${opt.imgUrl}" class="chart-poster-img" alt="${opt.text}">`
                    : `<div class="chart-poster-img" style="background:${opt.color || 'rgba(94,231,223,0.15)'};display:flex;align-items:center;justify-content:center;">
                         <span class="material-icons-round" style="font-size:1.8rem;opacity:0.5">movie</span>
                       </div>`
                }
                <span class="chart-poster-label">${opt.text}</span>
                <span class="chart-poster-votes">${opt.votes || 0} 🗳</span>
            </div>
        `;
    }).join('');
}

// ============================
// HISTORY
// ============================

function loadHistory() {
    if (unsubscribeHistory) unsubscribeHistory();
    unsubscribeHistory = onSnapshot(collection(db, 'sessions'), (snap) => {
        const list = document.getElementById('history-list');
        if (!list) return;
        list.innerHTML = "";

        const sessions = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        sessions.forEach(session => {
            const li = document.createElement('li');
            li.className = 'history-item';
            li.innerHTML = `
                <div class="history-item-body">
                    <span class="history-question">${session.question || 'Uten tittel'}</span>
                    <span class="history-status ${session.active ? 'status-active' : 'status-ended'}">
                        ${session.active ? 'Aktiv' : 'Avsluttet'}
                    </span>
                </div>
            `;
            // Delete button
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'history-delete-btn';
            deleteBtn.innerHTML = '<span class="material-icons-round">delete_outline</span>';
            deleteBtn.title = 'Slett fra historikk';
            deleteBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (confirm(`Slett "${session.question || 'Uten tittel'}" fra historikken?`)) {
                    try {
                        await deleteDoc(doc(db, 'sessions', session.id));
                    } catch (err) { alert('Kunne ikke slette: ' + err.message); }
                }
            });
            li.appendChild(deleteBtn);

            li.onclick = () => {
                currentSessionId = session.id;
                document.getElementById('creation-view').classList.add('hidden');
                document.getElementById('tournament-view').classList.add('hidden');
                document.getElementById('live-results-view').classList.remove('hidden');
                document.getElementById('display-code').innerText = session.code || '---';
                document.getElementById('qrcode').innerHTML = "";
                new QRCode(document.getElementById('qrcode'), {
                    text: `${location.origin}${location.pathname}?code=${session.code}`,
                    width: 100, height: 100
                });
                // Regular polls have no "next round" concept
                document.getElementById('next-round-btn').classList.add('hidden');
                document.getElementById('stop-poll-btn').classList.toggle('hidden', !session.active);
                renderResultsHeader(session);
                renderChart(session, 'results-chart');
                listenToResults(session.id);
            };
            list.appendChild(li);
        });
    });
}

// ============================
// TOURNAMENT
// ============================

document.getElementById('new-tournament-btn').onclick = () => {
    document.getElementById('creation-view').classList.add('hidden');
    document.getElementById('live-results-view').classList.add('hidden');
    document.getElementById('tournament-view').classList.remove('hidden');
    document.getElementById('tournament-setup').classList.remove('hidden');
    document.getElementById('tournament-bracket').classList.add('hidden');
    renderTournamentMovieSelect();
};

// Tournament movie display order (array of moviePool indices)
let tournamentDisplayOrder = [];

function renderTournamentMovieSelect() {
    const container = document.getElementById('tournament-movie-select');
    container.innerHTML = '';
    if (!moviePool.length) {
        container.innerHTML = '<div class="empty-pool-message">Ingen filmer i poolen. Legg til via TMDB-søk.</div>';
        document.getElementById('start-tournament-btn').disabled = true;
        document.getElementById('group-preview-wrap').classList.add('hidden');
        return;
    }

    // Init order if needed
    if (tournamentDisplayOrder.length !== moviePool.length) {
        tournamentDisplayOrder = moviePool.map((_, i) => i);
    }

    let dragSrcEl = null;

    tournamentDisplayOrder.forEach((poolIdx, displayPos) => {
        const movie = moviePool[poolIdx];
        const item = document.createElement('div');
        item.className = 'pool-item';
        item.draggable = true;
        item.dataset.displayPos = displayPos;

        item.innerHTML = `
            <span class="drag-handle material-icons-round">drag_indicator</span>
            <input type="checkbox" class="pool-item-checkbox t-select-cb" data-pool-idx="${poolIdx}">
            ${movie.posterUrl
                ? `<img src="${movie.posterUrl}" class="pool-item-poster" alt="">`
                : '<div class="no-poster"><span class="material-icons-round">movie</span></div>'}
            <span class="pool-item-title">${movie.title}</span>
        `;

        item.querySelector('.t-select-cb').addEventListener('change', () => {
            updateTournamentStartBtn();
            renderGroupPreview();
        });

        // ── Drag events ──
        item.addEventListener('dragstart', e => {
            dragSrcEl = item;
            e.dataTransfer.effectAllowed = 'move';
            setTimeout(() => item.classList.add('is-dragging'), 0);
        });

        item.addEventListener('dragend', () => {
            item.classList.remove('is-dragging');
            container.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
            dragSrcEl = null;
        });

        item.addEventListener('dragover', e => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (dragSrcEl && dragSrcEl !== item) {
                container.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
                item.classList.add('drag-over');
            }
        });

        item.addEventListener('dragleave', () => item.classList.remove('drag-over'));

        item.addEventListener('drop', e => {
            e.preventDefault();
            if (!dragSrcEl || dragSrcEl === item) return;
            item.classList.remove('drag-over');

            const allItems = [...container.querySelectorAll('.pool-item')];
            const srcPos = allItems.indexOf(dragSrcEl);
            const tgtPos = allItems.indexOf(item);

            const [moved] = tournamentDisplayOrder.splice(srcPos, 1);
            tournamentDisplayOrder.splice(tgtPos, 0, moved);

            renderTournamentMovieSelect();
            renderGroupPreview();
        });

        container.appendChild(item);
    });

    updateTournamentStartBtn();
    renderGroupPreview();
}

function renderGroupPreview() {
    const wrap = document.getElementById('group-preview-wrap');
    const container = document.getElementById('group-preview');
    if (!wrap || !container) return;

    // Get selected movies in current display order
    const allItems = [...document.querySelectorAll('#tournament-movie-select .pool-item')];
    const selectedMovies = [];
    allItems.forEach(item => {
        const cb = item.querySelector('.t-select-cb');
        if (cb && cb.checked) selectedMovies.push(moviePool[parseInt(cb.dataset.poolIdx)]);
    });

    if (selectedMovies.length < tournamentGroupSize) {
        wrap.classList.add('hidden');
        return;
    }

    wrap.classList.remove('hidden');
    const groups = computeGroupIndices(selectedMovies.length);

    container.innerHTML = groups.map((grp, gi) => {
        const movies = grp.map(i => selectedMovies[i]);
        return `
            <div class="group-preview-card">
                <div class="group-preview-label">Gruppe ${gi + 1}</div>
                ${movies.map(m => `
                    <div class="group-preview-movie">
                        ${m.posterUrl ? `<img src="${m.posterUrl}" class="group-preview-poster" alt="">` : '<span class="material-icons-round" style="font-size:0.9rem;opacity:0.5">movie</span>'}
                        <span>${m.title}</span>
                    </div>
                `).join('')}
            </div>
        `;
    }).join('');
}

function updateTournamentStartBtn() {
    const n = document.querySelectorAll('.t-select-cb:checked').length;
    const btn = document.getElementById('start-tournament-btn');
    const minNeeded = tournamentGroupSize;
    btn.disabled = n < minNeeded;
    btn.innerHTML = n >= minNeeded
        ? `<span class="material-icons-round">play_arrow</span> Start turnering med ${n} filmer`
        : `<span class="material-icons-round">play_arrow</span> Velg minst ${minNeeded} filmer (${n} valgt)`;
}

// "Legg til alle"-knapp i turneringsoppsett
document.getElementById('select-all-tournament-btn').addEventListener('click', () => {
    document.querySelectorAll('.t-select-cb').forEach(cb => { cb.checked = true; });
    updateTournamentStartBtn();
    renderGroupPreview();
});

// Group size selector — pill buttons
document.querySelectorAll('.group-size-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        tournamentGroupSize = parseInt(btn.dataset.size);
        document.querySelectorAll('.group-size-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        updateTournamentStartBtn();
        renderGroupPreview();
    });
});

function computeGroupIndices(total) {
    const groupSize = tournamentGroupSize || 4;
    const groups = [];
    let i = 0;
    while (i < total) {
        const size = Math.min(groupSize, total - i);
        groups.push(Array.from({ length: size }, (_, j) => i + j));
        i += size;
    }
    // Merge a too-small last group into the previous one
    if (groups.length > 1 && groups[groups.length - 1].length < 2) {
        const last = groups.pop();
        groups[groups.length - 1].push(...last);
    }
    return groups;
}

document.getElementById('start-tournament-btn').onclick = async () => {
    // Collect selected movies in current DISPLAY ORDER (teacher-defined order, not shuffled)
    const allItems = [...document.querySelectorAll('#tournament-movie-select .pool-item')];
    const selected = [];
    allItems.forEach(item => {
        const cb = item.querySelector('.t-select-cb');
        if (cb && cb.checked) selected.push(moviePool[parseInt(cb.dataset.poolIdx)]);
    });
    if (selected.length < tournamentGroupSize) { alert(`Velg minst ${tournamentGroupSize} filmer.`); return; }

    const shuffled = selected; // use teacher's ordering — no shuffle
    const groupIndices = computeGroupIndices(shuffled.length);
    const code = 'T' + Math.floor(10000 + Math.random() * 90000);

    const groups = {};
    groupIndices.forEach((indices, i) => {
        groups[String(i)] = { round: 0, movieIndices: indices, winnerMovieIndex: null, sessionId: null, status: 'waiting' };
    });

    const docRef = await addDoc(collection(db, 'tournaments'), {
        code, movies: shuffled, groups,
        currentGroupIdx: 0, currentRound: 0,
        status: 'waiting', timestamp: Date.now()
    });
    currentTournamentId = docRef.id;

    document.getElementById('tournament-setup').classList.add('hidden');
    document.getElementById('tournament-bracket').classList.remove('hidden');
    document.getElementById('tournament-code').innerText = code;
    document.getElementById('tournament-qrcode').innerHTML = "";
    new QRCode(document.getElementById('tournament-qrcode'), {
        text: `${location.origin}${location.pathname}?code=${code}`,
        width: 80, height: 80
    });

    subscribeTournament(currentTournamentId);
};

// ============================
// QR FULLSCREEN
// ============================

let qrFullscreenText = '';

function openQrFullscreen(text, codeLabel) {
    qrFullscreenText = text;
    const overlay = document.getElementById('qr-fullscreen-overlay');
    const codeDisplay = document.getElementById('qr-fs-code-text');
    const canvas = document.getElementById('qr-fs-canvas');

    codeDisplay.textContent = codeLabel || '';
    canvas.innerHTML = '';
    new QRCode(canvas, { text, width: 280, height: 280 });

    overlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}

function closeQrFullscreen() {
    document.getElementById('qr-fullscreen-overlay').classList.add('hidden');
    document.body.style.overflow = '';
}

// Click backdrop to close
document.getElementById('qr-fullscreen-overlay').addEventListener('click', e => {
    if (e.target.classList.contains('qr-fs-backdrop') || e.target.id === 'qr-fullscreen-overlay') {
        closeQrFullscreen();
    }
});
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeQrFullscreen();
});

// Click QR containers to open fullscreen
document.getElementById('qrcode').addEventListener('click', () => {
    const code = document.getElementById('display-code').textContent;
    if (code && code !== '---') {
        openQrFullscreen(`${location.origin}${location.pathname}?code=${code}`, code);
    }
});
document.getElementById('tournament-qrcode').addEventListener('click', () => {
    const code = document.getElementById('tournament-code').textContent;
    if (code && code !== '---') {
        openQrFullscreen(`${location.origin}${location.pathname}?code=${code}`, code);
    }
});

// ============================
// WINNER CELEBRATION
// ============================

let winnerShown = false;

function showWinnerCelebration(movie) {
    if (winnerShown) return;
    winnerShown = true;

    const overlay   = document.getElementById('winner-overlay');
    const posterImg = document.getElementById('winner-poster-img');
    const titleEl   = document.getElementById('winner-title-text');
    const taglineEl = document.getElementById('winner-tagline-text');

    if (!overlay) return;

    if (movie?.posterUrl) {
        posterImg.src = movie.posterUrl;
        posterImg.classList.remove('hidden');
    } else {
        posterImg.classList.add('hidden');
    }
    titleEl.textContent  = movie ? movie.title : 'Turneringen er over!';
    taglineEl.textContent = movie ? `${movie.title} vant!` : '';

    overlay.classList.remove('hidden');
    launchConfetti();
}

// Winner for regular polls (options have .text and optionally .imgUrl)
function showPollWinner(opt) {
    if (!opt || winnerShown) return;
    winnerShown = true;
    const overlay   = document.getElementById('winner-overlay');
    const posterImg = document.getElementById('winner-poster-img');
    const titleEl   = document.getElementById('winner-title-text');
    const taglineEl = document.getElementById('winner-tagline-text');
    if (!overlay) return;
    if (opt.imgUrl) {
        posterImg.src = opt.imgUrl;
        posterImg.classList.remove('hidden');
    } else {
        posterImg.classList.add('hidden');
    }
    titleEl.textContent   = opt.text;
    taglineEl.textContent = `${opt.text} vant!`;
    overlay.classList.remove('hidden');
    launchConfetti();
}

// Click anywhere on winner overlay to close it
document.getElementById('winner-overlay').addEventListener('click', () => {
    const overlay = document.getElementById('winner-overlay');
    overlay.classList.add('hidden');
    winnerShown = false;
});

function launchConfetti() {
    const container = document.getElementById('confetti-container');
    if (!container) return;
    const COLORS = ['#5ee7df','#b490f5','#f7a8c4','#ffd27f','#a8f08a','#f87171','#ffffff'];
    const count = 150;

    for (let i = 0; i < count; i++) {
        const delay = Math.random() * 1200;
        setTimeout(() => {
            const p = document.createElement('div');
            p.className = 'confetti-particle';
            const size = 7 + Math.random() * 11;
            p.style.cssText = [
                `left: ${Math.random() * 100}vw`,
                `width: ${size}px`,
                `height: ${size * (Math.random() > 0.5 ? 1 : 2.2)}px`,
                `background: ${COLORS[Math.floor(Math.random() * COLORS.length)]}`,
                `border-radius: ${Math.random() > 0.4 ? '50%' : '2px'}`,
                `animation-duration: ${1.8 + Math.random() * 2.2}s`,
                `animation-delay: 0s`,
                `transform: rotate(${Math.random()*360}deg)`
            ].join(';');
            container.appendChild(p);
            setTimeout(() => p.remove(), 4500);
        }, delay);
    }
}

function subscribeTournament(tId) {
    if (tournamentUnsubscribe) tournamentUnsubscribe();
    tournamentUnsubscribe = onSnapshot(doc(db, 'tournaments', tId), (snap) => {
        if (!snap.exists()) return;
        const data = { id: snap.id, ...snap.data() };
        currentTournamentData = data;
        renderBracket(data);

        const launchBtn = document.getElementById('launch-group-btn');
        const advanceBtn = document.getElementById('advance-tournament-btn');

        if (data.status === 'complete') {
            launchBtn.classList.add('hidden');
            advanceBtn.classList.add('hidden');
        } else if (data.status === 'voting') {
            launchBtn.classList.add('hidden');
            advanceBtn.classList.remove('hidden');
            const group = getCurrentGroup(data);
            if (group?.sessionId) {
                // Guard: only (re-)subscribe if this is a different session
                if (group.sessionId !== (adminChartUnsubscribe?._sessionId)) {
                    if (adminChartUnsubscribe) { adminChartUnsubscribe(); }
                    const unsub = onSnapshot(doc(db, 'sessions', group.sessionId), (sSn) => {
                        if (sSn.exists()) renderChart({ ...sSn.data() }, 'tournament-chart');
                    });
                    unsub._sessionId = group.sessionId; // tag so we can compare later
                    adminChartUnsubscribe = unsub;
                }
            }
        } else {
            launchBtn.classList.remove('hidden');
            advanceBtn.classList.add('hidden');
        }
    });
}

function getCurrentGroup(data) {
    return (data.groups || {})[String(data.currentGroupIdx)] || null;
}

document.getElementById('launch-group-btn').onclick = async () => {
    if (!currentTournamentId || !currentTournamentData) return;
    const data = currentTournamentData;
    const group = getCurrentGroup(data);
    if (!group) return;

    const movies = group.movieIndices.map(i => data.movies[i]);
    const COLORS = ['#ff6b6b', '#4a90e2', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22'];
    const optionsArr = movies.map((m, i) => ({
        text: m.title, color: COLORS[i % COLORS.length],
        textColor: '#ffffff', imgUrl: m.posterUrl || '', votes: 0
    }));

    const roundLabel = `Runde ${data.currentRound + 1}, Gruppe ${data.currentGroupIdx + 1}`;
    const sessionRef = await addDoc(collection(db, 'sessions'), {
        code: data.code + '_' + data.currentGroupIdx,
        question: `Turnering – ${roundLabel}`,
        options: optionsToMap(optionsArr),
        questionStyle: { fontFamily: 'inherit', fontSize: 28, bold: true, italic: false, textColor: '' },
        optionsStyle: { fontFamily: 'inherit', fontSize: 16, bold: false, italic: false },
        chartType: 'bar', maxVotes: 1, active: true,
        tournamentId: currentTournamentId, timestamp: Date.now()
    });

    const groupPath = `groups.${data.currentGroupIdx}`;
    await updateDoc(doc(db, 'tournaments', currentTournamentId), {
        [`${groupPath}.sessionId`]: sessionRef.id,
        [`${groupPath}.status`]: 'active',
        status: 'voting'
    });
};

document.getElementById('advance-tournament-btn').onclick = async () => {
    if (!currentTournamentId || !currentTournamentData) return;
    const data = currentTournamentData;
    const group = getCurrentGroup(data);
    if (!group?.sessionId) return;

    const sesSnap = await getDoc(doc(db, 'sessions', group.sessionId));
    if (!sesSnap.exists()) return;
    const sesData = sesSnap.data();
    const opts = optionsToArray(sesData.options);

    // Find max votes and check for a tie — single pass avoids stale-read race
    let maxVotes = -1;
    const tiedIndices = [];
    opts.forEach((opt, i) => {
        const v = opt.votes || 0;
        if (v > maxVotes)  { maxVotes = v; tiedIndices.length = 0; tiedIndices.push(i); }
        else if (v === maxVotes) { tiedIndices.push(i); }
    });

    if (tiedIndices.length > 1) {
        // TIE — start a tiebreaker session with only the tied movies
        await startTiebreaker(data, group, opts, tiedIndices);
        return;
    }

    // No tie — there is exactly one winner
    const winnerInGroupIdx = tiedIndices[0] ?? 0;
    const winnerMovieIndex = group.movieIndices[winnerInGroupIdx];

    await updateDoc(doc(db, 'sessions', group.sessionId), { active: false });
    const groupPath = `groups.${data.currentGroupIdx}`;
    await updateDoc(doc(db, 'tournaments', currentTournamentId), {
        [`${groupPath}.winnerMovieIndex`]: winnerMovieIndex,
        [`${groupPath}.status`]: 'done'
    });

    // Check if all groups in current round are done
    const allGroups = Object.values({ ...data.groups, [String(data.currentGroupIdx)]: { ...group, status: 'done', winnerMovieIndex } });
    const roundGroups = allGroups.filter(g => g.round === data.currentRound);
    const roundDone = roundGroups.every(g => g.status === 'done');

    if (roundDone) {
        const winners = roundGroups.map(g => g.winnerMovieIndex);
        if (winners.length === 1) {
            await updateDoc(doc(db, 'tournaments', currentTournamentId), {
                status: 'complete', winnerMovieIndex
            });
        } else {
            const nextGroupIndices = computeGroupIndices(winners.length);
            const nextRound = data.currentRound + 1;
            const nextGroupStart = Object.keys(data.groups).length;
            const newGroupUpdates = {};
            nextGroupIndices.forEach((indices, i) => {
                const key = `groups.${nextGroupStart + i}`;
                newGroupUpdates[key] = {
                    round: nextRound,
                    movieIndices: indices.map(i2 => winners[i2]),
                    winnerMovieIndex: null, sessionId: null, status: 'waiting'
                };
            });
            await updateDoc(doc(db, 'tournaments', currentTournamentId), {
                ...newGroupUpdates,
                currentGroupIdx: nextGroupStart,
                currentRound: nextRound,
                status: 'waiting'
            });
        }
    } else {
        await updateDoc(doc(db, 'tournaments', currentTournamentId), {
            currentGroupIdx: data.currentGroupIdx + 1,
            status: 'waiting'
        });
    }
};

async function startTiebreaker(data, group, opts, tiedIndices) {
    // Close current session
    await updateDoc(doc(db, 'sessions', group.sessionId), { active: false });

    // Collect tied movies (narrowed to just the tied ones)
    const tiedMovieIndices = tiedIndices.map(i => group.movieIndices[i]);
    const tiedMovies = tiedMovieIndices.map(mi => data.movies[mi]);

    const COLORS = ['#ff6b6b', '#4a90e2', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22'];
    const tieOptions = tiedMovies.map((m, i) => ({
        text: m.title, color: COLORS[i % COLORS.length],
        textColor: '#ffffff', imgUrl: m.posterUrl || '', votes: 0
    }));

    const tiedNames = tiedMovies.map(m => m.title).join(' vs. ');
    const tbRef = await addDoc(collection(db, 'sessions'), {
        code: data.code + '_' + data.currentGroupIdx + '_tb' + Date.now(),
        question: `Omspill: ${tiedNames}`,
        options: optionsToMap(tieOptions),
        questionStyle: { fontFamily: 'inherit', fontSize: 24, bold: true, italic: false, textColor: '' },
        optionsStyle:  { fontFamily: 'inherit', fontSize: 16, bold: false, italic: false },
        chartType: 'bar', maxVotes: 1, active: true,
        tournamentId: currentTournamentId, timestamp: Date.now()
    });

    // Update the group: new session + only tied movie indices remain
    const groupPath = `groups.${data.currentGroupIdx}`;
    await updateDoc(doc(db, 'tournaments', currentTournamentId), {
        [`${groupPath}.sessionId`]:     tbRef.id,
        [`${groupPath}.movieIndices`]:  tiedMovieIndices,
        [`${groupPath}.status`]:        'tiebreaker',
        status: 'voting'
    });

    // Show tiebreaker notice to teacher
    const notice = document.getElementById('tiebreaker-notice');
    const noticeText = document.getElementById('tiebreaker-notice-text');
    if (notice && noticeText) {
        noticeText.textContent = `Uavgjort! Ny votering mellom: ${tiedNames}`;
        notice.classList.remove('hidden');
        setTimeout(() => notice.classList.add('hidden'), 8000);
    }
}

function renderBracket(data) {
    const container = document.getElementById('bracket-display');
    if (!container) return;
    container.innerHTML = '';

    const groups = Object.values(data.groups || {});
    if (!groups.length) return;
    const maxRound = Math.max(...groups.map(g => g.round));

    for (let r = 0; r <= maxRound; r++) {
        const roundGroups = groups.filter(g => g.round === r);
        const roundDiv = document.createElement('div');
        roundDiv.className = 'bracket-round';
        const totalR0 = groups.filter(g => g.round === 0).length;
        const label = r === 0 ? 'Runde 1' : r === maxRound && totalR0 > 1 ? 'Finale' : `Runde ${r + 1}`;
        roundDiv.innerHTML = `<h4 class="bracket-round-label">${label}</h4>`;

        roundGroups.forEach((group) => {
            const globalIdx = Object.keys(data.groups).find(k => data.groups[k] === group);
            const isCurrent = String(data.currentGroupIdx) === String(globalIdx) && data.status !== 'complete';
            const gDiv = document.createElement('div');
            gDiv.className = `bracket-group${group.status === 'done' ? ' done' : ''}${isCurrent ? ' current' : ''}`;
            gDiv.innerHTML = (group.movieIndices || []).map((mi, i) => {
                const m = data.movies[mi];
                const isWinner = group.winnerMovieIndex === mi;
                return `<span class="bracket-movie${isWinner ? ' winner' : ''}">${isWinner ? '🏆 ' : ''}${m?.title || '?'}</span>`;
            }).join('');
            roundDiv.appendChild(gDiv);
        });
        container.appendChild(roundDiv);
    }

    // Admin winner display (below chart)
    const adminWinDiv = document.getElementById('admin-winner-display');
    if (adminWinDiv) {
        if (data.status === 'complete' && data.winnerMovieIndex != null) {
            const w = data.movies[data.winnerMovieIndex];
            adminWinDiv.classList.remove('hidden');
            adminWinDiv.innerHTML = `
                <div class="admin-winner-trophy">🏆</div>
                ${w?.posterUrl ? `<img src="${w.posterUrl}" class="admin-winner-poster" alt="${w.title}">` : ''}
                <div class="admin-winner-title">${w?.title || '?'}</div>
            `;
        } else {
            adminWinDiv.classList.add('hidden');
        }
    }
}

// ============================
// STUDENT VIEW
// ============================

document.getElementById('join-btn').onclick = () => {
    const code = document.getElementById('session-code-input').value.trim();
    document.getElementById('join-error').innerText = '';
    if (code) joinSession(code);
};

async function joinSession(code) {
    const errorEl = document.getElementById('join-error');
    if (code.toUpperCase().startsWith('T')) {
        joinTournament(code);
        return;
    }

    try {
        const q = query(collection(db, 'sessions'), where('code', '==', code), where('active', '==', true));
        const snap = await getDocs(q);
        if (snap.empty) {
            if (errorEl) errorEl.innerText = "Fant ingen aktiv sesjon med denne koden.";
            return;
        }
        const sessionDoc = snap.docs[0];
        currentSessionId = sessionDoc.id;
        // Restore persisted vote count so page refresh can't be used to re-vote
        myVotedSessions[currentSessionId] = LS.get('voted_' + currentSessionId) || 0;
        showView('student');
        renderStudentView({ id: sessionDoc.id, ...sessionDoc.data() });
        // Track listener so it can be cleaned up when leaving student view
        if (studentSessionUnsubscribe) studentSessionUnsubscribe();
        studentListeningSessionId = sessionDoc.id;
        studentSessionUnsubscribe = onSnapshot(doc(db, 'sessions', sessionDoc.id), (sn) => {
            if (sn.exists()) renderStudentView({ id: sn.id, ...sn.data() });
        });
    } catch (err) {
        console.error(err);
        if (errorEl) errorEl.innerText = "Feil: " + err.message;
    }
}

function joinTournament(code) {
    const errorEl = document.getElementById('join-error');
    const q = query(collection(db, 'tournaments'), where('code', '==', code));
    getDocs(q).then(snap => {
        if (snap.empty) {
            if (errorEl) errorEl.innerText = "Fant ingen turnering med denne koden.";
            return;
        }
        const tDoc = snap.docs[0];
        const tId = tDoc.id;
        showView('student');

        // Track the tournament listener so it can be cleaned up on view change
        if (studentTournamentUnsubscribe) studentTournamentUnsubscribe();
        studentTournamentUnsubscribe = onSnapshot(doc(db, 'tournaments', tId), (tSn) => {
            if (!tSn.exists()) return;
            const tData = { id: tSn.id, ...tSn.data() };

            const waitMsg = document.getElementById('waiting-message');
            const qEl = document.getElementById('student-question');

            if (tData.status === 'complete') {
                const w = tData.winnerMovieIndex != null ? tData.movies[tData.winnerMovieIndex] : null;
                document.getElementById('student-options').innerHTML = '';
                waitMsg.classList.add('hidden');
                showWinnerCelebration(w);
                return;
            }

            if (tData.status === 'voting') {
                winnerShown = false; // reset so celebration fires correctly for each final round
                const group = getCurrentGroup(tData);
                if (group?.sessionId) {
                    // Only create a new listener if this is a different session than before.
                    // Without this guard, every tournament doc change (many per round) would
                    // stack up a new session listener — causing duplicate renders and wasted
                    // connections that degrade performance on the student's device.
                    if (group.sessionId !== studentListeningSessionId) {
                        if (studentSessionUnsubscribe) {
                            studentSessionUnsubscribe();
                            studentSessionUnsubscribe = null;
                        }
                        studentListeningSessionId = group.sessionId;
                        studentSessionUnsubscribe = onSnapshot(doc(db, 'sessions', group.sessionId), (sSn) => {
                            if (sSn.exists() && sSn.data().active) {
                                waitMsg.classList.add('hidden');
                                currentSessionId = group.sessionId;
                                // Restore persisted vote count — blocks refresh-to-revote
                                myVotedSessions[currentSessionId] = LS.get('voted_' + currentSessionId) || 0;
                                renderStudentView({ id: sSn.id, ...sSn.data() });
                            } else {
                                document.getElementById('student-options').innerHTML = '';
                                qEl.textContent = 'Venter...';
                                waitMsg.classList.remove('hidden');
                            }
                        });
                    }
                }
            } else {
                qEl.textContent = `Gruppe ${tData.currentGroupIdx + 1} starter snart`;
                document.getElementById('student-options').innerHTML = '';
                waitMsg.classList.remove('hidden');
            }
        });
    }).catch(err => {
        if (errorEl) errorEl.innerText = "Feil: " + err.message;
    });
}

function renderStudentView(data) {
    if (!data) return;
    const waitMsg = document.getElementById('waiting-message');
    if (!data.active) {
        document.getElementById('student-question').textContent = "Sesjonen er avsluttet.";
        document.getElementById('student-options').innerHTML = "";
        waitMsg.classList.add('hidden');
        return;
    }
    waitMsg.classList.add('hidden');

    const qEl = document.getElementById('student-question');
    qEl.textContent = data.question;
    applyTextStyle(qEl, data.questionStyle);

    const qImgWrap = document.getElementById('student-question-img-wrap');
    const qImg = document.getElementById('student-question-img');
    if (data.questionImgUrl) {
        qImg.src = data.questionImgUrl;
        qImgWrap.classList.remove('hidden');
    } else {
        qImgWrap.classList.add('hidden');
    }

    const container = document.getElementById('student-options');
    container.innerHTML = "";
    const os = data.optionsStyle || {};
    const voteCount = myVotedSessions[currentSessionId] || 0;
    const maxVotes = data.maxVotes || 1;
    const opts = optionsToArray(data.options);

    opts.forEach((opt, index) => {
        const card = document.createElement('div');
        card.className = 'vote-card' + (voteCount >= maxVotes ? ' voted' : '');
        card.style.borderColor = opt.color;
        card.innerHTML = `
            ${opt.imgUrl ? `<img src="${opt.imgUrl}" class="vote-card-img" alt="">` : ''}
            <span class="vote-card-text">${opt.text}</span>
        `;
        applyTextStyle(card.querySelector('.vote-card-text'), { ...os, textColor: opt.textColor });
        if (voteCount < maxVotes) card.onclick = () => submitVote(index, data);
        container.appendChild(card);
    });
}

async function submitVote(optionIndex, data) {
    const voteCount = myVotedSessions[currentSessionId] || 0;
    const maxVotes  = data.maxVotes || 1;
    if (voteCount >= maxVotes) {
        document.getElementById('vote-status').innerText = "Du har brukt alle stemmene dine.";
        return;
    }
    // Optimistic lock: increment BEFORE the async call so rapid double-clicks
    // are blocked immediately rather than racing to pass the check above.
    const newCount = voteCount + 1;
    myVotedSessions[currentSessionId] = newCount;
    // Persist to localStorage — survives page refresh, preventing the refresh-to-revote exploit
    LS.set('voted_' + currentSessionId, newCount);
    try {
        await updateDoc(doc(db, 'sessions', currentSessionId), {
            [`options.${optionIndex}.votes`]: increment(1)
        });
        const remaining = maxVotes - newCount;
        document.getElementById('vote-status').innerText = remaining > 0
            ? `Stemme registrert! ${remaining} igjen.`
            : "Alle stemmer avgitt! ✓";
    } catch (err) {
        // Revert both in-memory and localStorage on failure so the student can try again
        myVotedSessions[currentSessionId] = voteCount;
        LS.set('voted_' + currentSessionId, voteCount);
        console.error(err);
        document.getElementById('vote-status').innerText = "Feil ved stemming — prøv igjen.";
    }
}

// ============================
// TMDB & MOVIE POOL
// ============================

const PRESET_COLORS = ['#ff6b6b', '#4a90e2', '#2ecc71', '#f1c40f'];

function saveMoviePool() {
    setDoc(doc(db, 'movie_pool', 'items'), { movies: moviePool })
        .catch(e => console.warn('Movie pool save failed:', e));
}

function renderMoviePool() {
    const list = document.getElementById('movie-pool-list');
    const countEl = document.getElementById('pool-count');
    if (!list) return;
    list.innerHTML = '';
    if (!moviePool.length) {
        list.innerHTML = '<div class="empty-pool-message">Ingen filmer lagt til ennå. Søk over for å legge til.</div>';
        if (countEl) countEl.innerText = '0';
        const btn = document.getElementById('populate-poll-btn');
        if (btn) btn.disabled = true;
        return;
    }
    if (countEl) countEl.innerText = moviePool.length;
    moviePool.forEach((movie, idx) => {
        const item = document.createElement('div');
        item.className = `pool-item${movie.selected ? ' selected' : ''}`;
        item.innerHTML = `
            <input type="checkbox" class="pool-item-checkbox" ${movie.selected ? 'checked' : ''} data-index="${idx}">
            ${movie.posterUrl ? `<img src="${movie.posterUrl}" class="pool-item-poster" alt="">` : '<div class="pool-item-poster no-poster"><span class="material-icons-round">movie</span></div>'}
            <span class="pool-item-title">${movie.title}</span>
            <button class="pool-item-remove" data-index="${idx}" title="Fjern">
                <span class="material-icons-round">delete</span>
            </button>
        `;
        item.querySelector('.pool-item-checkbox').addEventListener('change', (e) => {
            moviePool[idx].selected = e.target.checked;
            saveMoviePool();
        });
        item.querySelector('.pool-item-remove').addEventListener('click', () => {
            moviePool.splice(idx, 1);
            saveMoviePool();
        });
        list.appendChild(item);
    });
    updatePopulateBtn();
}

function updatePopulateBtn() {
    const n = moviePool.filter(m => m.selected).length;
    const btn = document.getElementById('populate-poll-btn');
    if (btn) btn.disabled = n !== 4;
}

document.getElementById('clear-pool-btn').onclick = () => {
    if (confirm("Tøm hele film-poolen?")) { moviePool = []; saveMoviePool(); }
};

const searchInput = document.getElementById('tmdb-search-input');
const searchBtn = document.getElementById('tmdb-search-btn');
const searchResults = document.getElementById('tmdb-search-results');

const performSearch = async () => {
    const queryText = searchInput.value.trim();
    if (!queryText) return;
    searchBtn.disabled = true;
    try {
        const res = await fetch(`https://api.themoviedb.org/3/search/movie?api_key=${tmdbApiKey}&query=${encodeURIComponent(queryText)}&language=no-NO`);
        if (!res.ok) throw new Error("Ugyldig API-nøkkel eller nettverksfeil.");
        const json = await res.json();
        renderSearchResults(json.results || []);
    } catch (err) {
        alert(err.message);
    } finally {
        searchBtn.disabled = false;
    }
};

searchBtn.onclick = performSearch;
searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') performSearch(); });

function renderSearchResults(results) {
    searchResults.innerHTML = '';
    searchResults.classList.remove('hidden');
    if (!results.length) {
        searchResults.innerHTML = '<div style="padding:15px;text-align:center;opacity:0.7">Ingen filmer funnet.</div>';
        return;
    }
    results.slice(0, 5).forEach(movie => {
        const item = document.createElement('div');
        item.className = 'search-result-item';
        const thumb = movie.poster_path ? `https://image.tmdb.org/t/p/w92${movie.poster_path}` : '';
        const full = movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : '';
        const year = movie.release_date?.substring(0, 4) || '';
        item.innerHTML = `
            ${thumb ? `<img src="${thumb}" alt="">` : '<div style="width:32px;height:46px;background:#ddd;border-radius:5px;"></div>'}
            <div class="search-result-info">
                <span class="search-result-title">${movie.title}</span>
                <span class="search-result-year">${year}</span>
            </div>
            <span class="material-icons-round" style="color:var(--primary)">add_circle</span>
        `;
        item.onclick = () => {
            if (moviePool.some(m => m.id === movie.id)) { alert("Filmen er allerede i poolen."); return; }
            moviePool.push({ id: movie.id, title: movie.title, posterUrl: full, selected: false });
            saveMoviePool();
            searchInput.value = '';
            searchResults.classList.add('hidden');
        };
        searchResults.appendChild(item);
    });
}

document.addEventListener('click', (e) => {
    if (!searchResults.classList.contains('hidden') &&
        !searchResults.contains(e.target) && e.target !== searchInput && e.target !== searchBtn) {
        searchResults.classList.add('hidden');
    }
});

document.getElementById('populate-poll-btn').onclick = () => {
    const selected = moviePool.filter(m => m.selected);
    if (selected.length !== 4) { alert("Velg nøyaktig 4 filmer."); return; }
    const container = document.getElementById('options-container');
    if (container.children.length && !confirm("Erstatter gjeldende alternativer. Fortsette?")) return;
    const qInput = document.getElementById('question-text');
    if (!qInput.value.trim()) qInput.value = "Hvilken film skal vi se?";
    container.innerHTML = '';
    selected.forEach((m, i) => createOptionRow(m.title, PRESET_COLORS[i], m.posterUrl));
    moviePool.forEach(m => { if (m.selected) m.selected = false; });
    saveMoviePool();
};

renderMoviePool();
