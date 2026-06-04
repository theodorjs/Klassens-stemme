import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-app.js";
import { getDatabase, ref, set, get, onValue, push, update } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-database.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js";
import { getStorage, ref as sRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-storage.js";

const firebaseConfig = {
    apiKey: "AIzaSyDFb5GK8bUZP2ZpMByG9-X1JiL-jNPFrKY",
    authDomain: "klassens-stemme.firebaseapp.com",
    databaseURL: "https://klassens-stemme-default-rtdb.firebaseio.com/",
    projectId: "klassens-stemme",
    storageBucket: "klassens-stemme.firebasestorage.app",
    messagingSenderId: "607973299678",
    appId: "1:607973299678:web:250efdd7104d32c050394f"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);
const storage = getStorage(app);

// Global state
let currentSessionId = null;
let myVotedSessions = {};
let chartInstance = null;
let tournamentChartInstance = null;
let tmdbApiKey = "";
let moviePool = [];
let currentTournamentId = null;
let currentTournamentData = null;
let dbListenersAttached = false;
let unsubscribeMoviePool = null;
let unsubscribeTmdbKey = null;
let tournamentUnsubscribe = null;
let questionImgFile = null;

const views = {
    landing: document.getElementById('landing-page'),
    admin: document.getElementById('admin-dashboard'),
    student: document.getElementById('student-view')
};

// ============================
// GLOBAL SETTINGS (all users)
// ============================

onValue(ref(db, 'settings/darkMode'), (snap) => {
    document.body.classList.toggle('dark-mode', !!snap.val());
    updateThemeIcon();
});

onValue(ref(db, 'settings/backgroundUrl'), (snap) => {
    const url = snap.val();
    document.getElementById('app-background').style.backgroundImage = url ? `url('${url}')` : '';
});

function updateThemeIcon() {
    const isDark = document.body.classList.contains('dark-mode');
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    btn.querySelector('.material-icons-round').textContent = isDark ? 'light_mode' : 'dark_mode';
    btn.querySelector('.label').textContent = isDark ? 'Lys modus' : 'Mørk modus';
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
    } else {
        showView('landing');
        if (pendingCode) {
            joinSession(pendingCode);
            pendingCode = null;
        }
        loginBtn.classList.remove('hidden');
        logoutBtn.classList.add('hidden');
        if (bgLabel) bgLabel.style.display = 'none';
        if (adminDivider) adminDivider.style.display = 'none';
        if (tmdbGroup) tmdbGroup.style.display = 'none';
        detachDatabaseListeners();
        dbListenersAttached = false;
    }
});

document.getElementById('admin-login-btn').onclick = () => {
    document.getElementById('login-modal').classList.remove('hidden');
};

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

document.getElementById('logout-btn').onclick = () => {
    signOut(auth).catch(err => alert("Kunne ikke logge ut: " + err.message));
};

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
    const isDark = document.body.classList.contains('dark-mode');
    set(ref(db, 'settings/darkMode'), !isDark);
};

document.getElementById('bg-upload-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        document.getElementById('app-background').style.backgroundImage = `url('${ev.target.result}')`;
    };
    reader.readAsDataURL(file);
    try {
        const storageRef = sRef(storage, 'backgrounds/' + Date.now());
        await uploadBytes(storageRef, file);
        const url = await getDownloadURL(storageRef);
        await set(ref(db, 'settings/backgroundUrl'), url);
    } catch (err) {
        console.error(err);
        alert("Lokal visning aktiv, men kunne ikke lagre til Firebase.");
    }
});

// ============================
// DB LISTENERS (admin only)
// ============================

function attachDatabaseListeners() {
    const tmdbInput = document.getElementById('tmdb-key-input');
    unsubscribeTmdbKey = onValue(ref(db, 'settings/tmdb_api_key'), (snap) => {
        tmdbApiKey = snap.val() || "";
        if (tmdbInput && document.activeElement !== tmdbInput) tmdbInput.value = tmdbApiKey;
    });
    unsubscribeMoviePool = onValue(ref(db, 'movie_pool'), (snap) => {
        moviePool = snap.val() || [];
        renderMoviePool();
    });
    loadHistory();
}

function detachDatabaseListeners() {
    if (unsubscribeTmdbKey) { unsubscribeTmdbKey(); unsubscribeTmdbKey = null; }
    if (unsubscribeMoviePool) { unsubscribeMoviePool(); unsubscribeMoviePool = null; }
}

let tmdbKeyTimer = null;
document.getElementById('tmdb-key-input').addEventListener('input', (e) => {
    clearTimeout(tmdbKeyTimer);
    tmdbKeyTimer = setTimeout(() => {
        set(ref(db, 'settings/tmdb_api_key'), e.target.value.trim());
    }, 800);
});

// ============================
// VIEW
// ============================

function showView(name) {
    Object.values(views).forEach(el => el.classList.add('hidden'));
    views[name].classList.remove('hidden');
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
    if (style.textColor) el.style.color = style.textColor;
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

function createOptionRow(text = "", color = "#4a90e2", imgUrl = "", textColor = "#ffffff") {
    const container = document.getElementById('options-container');
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
            const imgRef = sRef(storage, `questions/${Date.now()}_${questionImgFile.name}`);
            await uploadBytes(imgRef, questionImgFile);
            questionImgUrl = await getDownloadURL(imgRef);
        }

        const optionsData = [];
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
            optionsData.push({ text, color, textColor, imgUrl, votes: 0 });
        }

        const sessionRef = push(ref(db, 'sessions'));
        currentSessionId = sessionRef.key;
        await set(sessionRef, {
            code, question, questionStyle, questionImgUrl,
            optionsStyle, options: optionsData,
            chartType: document.getElementById('chart-type').value,
            maxVotes: parseInt(document.getElementById('max-votes').value) || 1,
            active: true, timestamp: Date.now()
        });

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
}

document.getElementById('create-new-btn').onclick = () => {
    currentSessionId = null;
    document.getElementById('question-text').value = "";
    document.getElementById('options-container').innerHTML = "";
    questionImgFile = null;
    document.getElementById('question-img-preview').classList.add('hidden');
    document.getElementById('question-img-input').value = "";
    ['q-font-family', 'opt-font-family'].forEach(id => document.getElementById(id).value = 'inherit');
    document.getElementById('q-font-size').value = '32';
    document.getElementById('opt-font-size').value = '18';
    document.getElementById('q-text-color').value = '#333333';
    ['q-bold', 'q-italic', 'opt-bold', 'opt-italic'].forEach(id => document.getElementById(id).classList.remove('active'));
    document.getElementById('creation-view').classList.remove('hidden');
    document.getElementById('live-results-view').classList.add('hidden');
    document.getElementById('tournament-view').classList.add('hidden');
};

document.getElementById('stop-poll-btn').onclick = async () => {
    if (currentSessionId) {
        await update(ref(db, `sessions/${currentSessionId}`), { active: false }).catch(console.error);
    }
    document.getElementById('creation-view').classList.remove('hidden');
    document.getElementById('live-results-view').classList.add('hidden');
};

document.getElementById('next-round-btn').onclick = async () => {
    if (currentSessionId) {
        await update(ref(db, `sessions/${currentSessionId}`), { active: false }).catch(console.error);
    }
    document.getElementById('creation-view').classList.remove('hidden');
    document.getElementById('live-results-view').classList.add('hidden');
};

// ============================
// RESULTS
// ============================

function listenToResults(sessionId) {
    onValue(ref(db, `sessions/${sessionId}`), (snap) => {
        const data = snap.val();
        if (!data) return;
        renderResultsHeader(data);
        renderChart(data, 'results-chart', (inst) => { chartInstance = inst; });
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

function renderChart(data, canvasId, onCreated) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (canvasId === 'results-chart' && chartInstance) { chartInstance.destroy(); chartInstance = null; }
    if (canvasId === 'tournament-chart' && tournamentChartInstance) { tournamentChartInstance.destroy(); tournamentChartInstance = null; }

    const opts = Array.isArray(data.options) ? data.options : Object.values(data.options || {});
    const inst = new Chart(canvas.getContext('2d'), {
        type: data.chartType || 'bar',
        data: {
            labels: opts.map(o => o.text),
            datasets: [{
                label: '# Stemmer',
                data: opts.map(o => o.votes || 0),
                backgroundColor: opts.map(o => o.color),
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: { labels: { color: getComputedStyle(document.body).getPropertyValue('--text-color') } }
            }
        }
    });
    if (canvasId === 'results-chart') chartInstance = inst;
    else tournamentChartInstance = inst;
    if (onCreated) onCreated(inst);
}

// ============================
// HISTORY
// ============================

function loadHistory() {
    onValue(ref(db, 'sessions'), (snap) => {
        const list = document.getElementById('history-list');
        if (!list) return;
        list.innerHTML = "";
        const data = snap.val();
        if (!data) return;

        Object.keys(data)
            .map(key => ({ id: key, ...data[key] }))
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
            .forEach(session => {
                const li = document.createElement('li');
                li.className = 'history-item';
                li.innerHTML = `
                    <span class="history-question">${session.question || 'Uten tittel'}</span>
                    <span class="history-status ${session.active ? 'status-active' : 'status-ended'}">
                        ${session.active ? 'Aktiv' : 'Avsluttet'}
                    </span>
                `;
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
                    document.getElementById('next-round-btn').classList.toggle('hidden', !session.active);
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

function renderTournamentMovieSelect() {
    const container = document.getElementById('tournament-movie-select');
    container.innerHTML = '';
    if (!moviePool.length) {
        container.innerHTML = '<div class="empty-pool-message">Ingen filmer i poolen. Legg til via TMDB-søk.</div>';
        document.getElementById('start-tournament-btn').disabled = true;
        return;
    }
    moviePool.forEach((movie, idx) => {
        const item = document.createElement('div');
        item.className = 'pool-item';
        item.innerHTML = `
            <input type="checkbox" class="pool-item-checkbox t-select-cb" data-index="${idx}">
            ${movie.posterUrl ? `<img src="${movie.posterUrl}" class="pool-item-poster" alt="">` : '<div class="pool-item-poster no-poster"><span class="material-icons-round">movie</span></div>'}
            <span class="pool-item-title">${movie.title}</span>
        `;
        item.querySelector('.t-select-cb').addEventListener('change', updateTournamentStartBtn);
        container.appendChild(item);
    });
    updateTournamentStartBtn();
}

function updateTournamentStartBtn() {
    const n = document.querySelectorAll('.t-select-cb:checked').length;
    const btn = document.getElementById('start-tournament-btn');
    btn.disabled = n < 4;
    btn.innerHTML = n >= 4
        ? `<span class="material-icons-round">play_arrow</span> Start turnering med ${n} filmer`
        : `<span class="material-icons-round">play_arrow</span> Velg minst 4 filmer (${n} valgt)`;
}

function computeGroupIndices(total) {
    const groups = [];
    let i = 0;
    while (i < total) {
        const size = Math.min(4, total - i);
        groups.push(Array.from({ length: size }, (_, j) => i + j));
        i += size;
    }
    // Merge a group of 1 into the previous group
    if (groups.length > 1 && groups[groups.length - 1].length < 2) {
        const last = groups.pop();
        groups[groups.length - 1].push(...last);
    }
    return groups;
}

document.getElementById('start-tournament-btn').onclick = async () => {
    const cbs = document.querySelectorAll('.t-select-cb:checked');
    const selected = Array.from(cbs).map(cb => moviePool[parseInt(cb.dataset.index)]);
    if (selected.length < 4) { alert("Velg minst 4 filmer."); return; }

    const shuffled = [...selected].sort(() => Math.random() - 0.5);
    const groupIndices = computeGroupIndices(shuffled.length);
    const code = 'T' + Math.floor(10000 + Math.random() * 90000);

    const groups = {};
    groupIndices.forEach((indices, i) => {
        groups[i] = { round: 0, movieIndices: indices, winnerMovieIndex: null, sessionId: null, status: 'waiting' };
    });

    const tournRef = push(ref(db, 'tournaments'));
    currentTournamentId = tournRef.key;
    await set(tournRef, {
        code, movies: shuffled, groups,
        currentGroupIdx: 0, currentRound: 0,
        status: 'waiting', timestamp: Date.now()
    });

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

function subscribeTournament(tId) {
    if (tournamentUnsubscribe) tournamentUnsubscribe();
    tournamentUnsubscribe = onValue(ref(db, `tournaments/${tId}`), (snap) => {
        const data = snap.val();
        if (!data) return;
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
                onValue(ref(db, `sessions/${group.sessionId}`), (sSn) => {
                    if (sSn.val()) renderChart(sSn.val(), 'tournament-chart');
                });
            }
        } else {
            launchBtn.classList.remove('hidden');
            advanceBtn.classList.add('hidden');
        }
    });
}

function getCurrentGroup(data) {
    const groups = data.groups || {};
    return groups[data.currentGroupIdx] || null;
}

document.getElementById('launch-group-btn').onclick = async () => {
    if (!currentTournamentId || !currentTournamentData) return;
    const data = currentTournamentData;
    const group = getCurrentGroup(data);
    if (!group) return;

    const movies = group.movieIndices.map(i => data.movies[i]);
    const COLORS = ['#ff6b6b', '#4a90e2', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22'];

    const sessionRef = push(ref(db, 'sessions'));
    const sessionId = sessionRef.key;
    const roundLabel = `Runde ${data.currentRound + 1}, Gruppe ${data.currentGroupIdx - Object.values(data.groups).filter(g => g.round < data.currentRound).length + 1}`;
    await set(sessionRef, {
        code: data.code + '_' + data.currentGroupIdx,
        question: `Turnering – ${roundLabel}`,
        options: movies.map((m, i) => ({
            text: m.title, color: COLORS[i % COLORS.length],
            textColor: '#ffffff', imgUrl: m.posterUrl || '', votes: 0
        })),
        questionStyle: { fontFamily: 'inherit', fontSize: 28, bold: true, italic: false, textColor: '' },
        optionsStyle: { fontFamily: 'inherit', fontSize: 16, bold: false, italic: false },
        chartType: 'bar', maxVotes: 1, active: true,
        tournamentId: currentTournamentId, timestamp: Date.now()
    });

    await update(ref(db, `tournaments/${currentTournamentId}/groups/${data.currentGroupIdx}`), {
        sessionId, status: 'active'
    });
    await update(ref(db, `tournaments/${currentTournamentId}`), { status: 'voting' });
};

document.getElementById('advance-tournament-btn').onclick = async () => {
    if (!currentTournamentId || !currentTournamentData) return;
    const data = currentTournamentData;
    const group = getCurrentGroup(data);
    if (!group?.sessionId) return;

    const sesSnap = await get(ref(db, `sessions/${group.sessionId}`));
    const sesData = sesSnap.val();
    if (!sesData) return;

    const opts = Array.isArray(sesData.options) ? sesData.options : Object.values(sesData.options);
    let maxVotes = -1, winnerInGroupIdx = 0;
    opts.forEach((opt, i) => {
        if ((opt.votes || 0) > maxVotes) { maxVotes = opt.votes || 0; winnerInGroupIdx = i; }
    });
    const winnerMovieIndex = group.movieIndices[winnerInGroupIdx];

    await update(ref(db, `sessions/${group.sessionId}`), { active: false });
    await update(ref(db, `tournaments/${currentTournamentId}/groups/${data.currentGroupIdx}`), {
        winnerMovieIndex, status: 'done'
    });

    // Check if all groups in current round are done
    const allGroups = Object.values({ ...data.groups, [data.currentGroupIdx]: { ...group, status: 'done', winnerMovieIndex } });
    const roundGroups = allGroups.filter(g => g.round === data.currentRound);
    const roundDone = roundGroups.every(g => g.status === 'done');

    if (roundDone) {
        const winners = roundGroups.map(g => g.winnerMovieIndex);
        if (winners.length === 1) {
            await update(ref(db, `tournaments/${currentTournamentId}`), {
                status: 'complete', winnerMovieIndex
            });
        } else {
            const nextGroupIndices = computeGroupIndices(winners.length);
            const nextRound = data.currentRound + 1;
            const nextGroupStart = Object.keys(data.groups).length;
            const newGroups = {};
            nextGroupIndices.forEach((indices, i) => {
                newGroups[nextGroupStart + i] = {
                    round: nextRound,
                    movieIndices: indices.map(i2 => winners[i2]),
                    winnerMovieIndex: null, sessionId: null, status: 'waiting'
                };
            });
            await update(ref(db, `tournaments/${currentTournamentId}`), {
                ...Object.fromEntries(Object.entries(newGroups).map(([k, v]) => [`groups/${k}`, v])),
                currentGroupIdx: nextGroupStart,
                currentRound: nextRound,
                status: 'waiting'
            });
        }
    } else {
        await update(ref(db, `tournaments/${currentTournamentId}`), {
            currentGroupIdx: data.currentGroupIdx + 1,
            status: 'waiting'
        });
    }
};

function renderBracket(data) {
    const container = document.getElementById('bracket-display');
    if (!container) return;
    container.innerHTML = '';

    const groups = Object.values(data.groups || {});
    const maxRound = Math.max(...groups.map(g => g.round));

    for (let r = 0; r <= maxRound; r++) {
        const roundGroups = groups.filter(g => g.round === r);
        const roundDiv = document.createElement('div');
        roundDiv.className = 'bracket-round';
        const totalGroups = groups.filter(g => g.round === 0).length;
        const label = r === 0 ? 'Runde 1' : r === maxRound && totalGroups > 1 ? 'Finale' : `Runde ${r + 1}`;
        roundDiv.innerHTML = `<h4 class="bracket-round-label">${label}</h4>`;

        roundGroups.forEach((group, groupLocalIdx) => {
            const globalIdx = groups.findIndex(g => g === group);
            const isCurrent = data.currentGroupIdx === globalIdx && data.status !== 'complete';
            const gDiv = document.createElement('div');
            gDiv.className = `bracket-group${group.status === 'done' ? ' done' : ''}${isCurrent ? ' current' : ''}`;

            const movies = (group.movieIndices || []).map(i => data.movies[i]);
            gDiv.innerHTML = movies.map((m, i) => {
                const isWinner = group.winnerMovieIndex === group.movieIndices[i];
                return `<span class="bracket-movie${isWinner ? ' winner' : ''}">${isWinner ? '🏆 ' : ''}${m?.title || '?'}</span>`;
            }).join('');

            roundDiv.appendChild(gDiv);
        });
        container.appendChild(roundDiv);
    }

    if (data.status === 'complete' && data.winnerMovieIndex != null) {
        const w = data.movies[data.winnerMovieIndex];
        const winDiv = document.createElement('div');
        winDiv.className = 'tournament-winner-display';
        winDiv.innerHTML = `🏆 <strong>${w?.title}</strong>`;
        container.appendChild(winDiv);
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

function joinSession(code) {
    const errorEl = document.getElementById('join-error');
    if (code.toUpperCase().startsWith('T')) {
        joinTournament(code);
        return;
    }
    onValue(ref(db, 'sessions'), (snap) => {
        const sessions = snap.val() || {};
        const found = Object.entries(sessions).find(([, s]) => String(s.code) === String(code) && s.active);
        if (found) {
            const [id, sessionData] = found;
            currentSessionId = id;
            myVotedSessions[id] = myVotedSessions[id] || 0;
            showView('student');
            renderStudentView(sessionData);
            onValue(ref(db, `sessions/${id}`), (sn) => renderStudentView(sn.val()));
        } else {
            if (errorEl) errorEl.innerText = "Fant ingen aktiv sesjon med denne koden.";
        }
    }, { onlyOnce: true });
}

function joinTournament(code) {
    const errorEl = document.getElementById('join-error');
    onValue(ref(db, 'tournaments'), (snap) => {
        const tournaments = snap.val() || {};
        const found = Object.entries(tournaments).find(([, t]) => t.code?.toLowerCase() === code.toLowerCase());
        if (!found) {
            if (errorEl) errorEl.innerText = "Fant ingen turnering med denne koden.";
            return;
        }
        const [tId] = found;
        showView('student');

        onValue(ref(db, `tournaments/${tId}`), (tSn) => {
            const tData = tSn.val();
            if (!tData) return;

            const waitMsg = document.getElementById('waiting-message');
            const qEl = document.getElementById('student-question');

            if (tData.status === 'complete') {
                const w = tData.winnerMovieIndex != null ? tData.movies[tData.winnerMovieIndex] : null;
                qEl.textContent = w ? `🏆 Vinner: ${w.title}` : 'Turneringen er over!';
                document.getElementById('student-options').innerHTML = '';
                waitMsg.classList.add('hidden');
                return;
            }

            if (tData.status === 'voting') {
                const group = getCurrentGroup(tData);
                if (group?.sessionId) {
                    onValue(ref(db, `sessions/${group.sessionId}`), (sSn) => {
                        const sesData = sSn.val();
                        if (sesData?.active) {
                            waitMsg.classList.add('hidden');
                            currentSessionId = group.sessionId;
                            myVotedSessions[currentSessionId] = myVotedSessions[currentSessionId] || 0;
                            renderStudentView(sesData);
                        } else {
                            document.getElementById('student-options').innerHTML = '';
                            qEl.textContent = 'Avstemning pågår...';
                            waitMsg.classList.remove('hidden');
                        }
                    });
                }
            } else {
                const r = tData.currentRound + 1;
                const total = Object.values(tData.groups || {}).filter(g => g.round === 0).length;
                qEl.textContent = tData.status === 'waiting' ? `Runde ${r} • Gruppe starter snart` : '';
                document.getElementById('student-options').innerHTML = '';
                waitMsg.classList.remove('hidden');
            }
        });
    }, { onlyOnce: true });
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
    const opts = Array.isArray(data.options) ? data.options : Object.values(data.options || {});

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

function submitVote(optionIndex, data) {
    const voteCount = myVotedSessions[currentSessionId] || 0;
    const maxVotes = data.maxVotes || 1;
    if (voteCount >= maxVotes) {
        document.getElementById('vote-status').innerText = "Du har brukt alle stemmene dine.";
        return;
    }
    const opts = Array.isArray(data.options) ? data.options : Object.values(data.options || {});
    const currentVotes = opts[optionIndex]?.votes || 0;
    update(ref(db, `sessions/${currentSessionId}/options/${optionIndex}`), { votes: currentVotes + 1 });
    myVotedSessions[currentSessionId] = voteCount + 1;
    const remaining = maxVotes - (voteCount + 1);
    document.getElementById('vote-status').innerText = remaining > 0
        ? `Stemme registrert! ${remaining} igjen.`
        : "Alle stemmer avgitt! ✓";
}

// ============================
// TMDB & MOVIE POOL
// ============================

const PRESET_COLORS = ['#ff6b6b', '#4a90e2', '#2ecc71', '#f1c40f'];

function saveMoviePool() {
    set(ref(db, 'movie_pool'), moviePool);
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
    const query = searchInput.value.trim();
    if (!query) return;
    if (!tmdbApiKey) { alert("Legg inn TMDB API-nøkkel i menyen øverst til høyre."); return; }
    searchBtn.disabled = true;
    try {
        const res = await fetch(`https://api.themoviedb.org/3/search/movie?api_key=${tmdbApiKey}&query=${encodeURIComponent(query)}&language=no-NO`);
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
            ${thumb ? `<img src="${thumb}" alt="">` : '<div style="width:35px;height:50px;background:#ddd;border-radius:4px;"></div>'}
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
