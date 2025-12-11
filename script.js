// Importer Firebase funksjoner (CDN versjon)
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.0.0/firebase-app.js";
import { getDatabase, ref, set, onValue, push, update } from "https://www.gstatic.com/firebasejs/9.0.0/firebase-database.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.0.0/firebase-auth.js";
import { getStorage, ref as sRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/9.0.0/firebase-storage.js";

// --- KONFIGURASJON (ERSTATT MED DIN EGEN FRA FIREBASE CONSOLE) ---
const firebaseConfig = {
    apiKey: "AIzaSyCYx3IV-ZwlhfIT2zKrIUD_K_caJ4UFAeU",
    authDomain: "klassens-stemme.firebaseapp.com",
    projectId: "klassens-stemme",
    storageBucket: "klassens-stemme.firebasestorage.app",
    messagingSenderId: "607973299678",
    appId: "1:607973299678:web:250efdd7104d32c050394f",
    measurementId: "G-9H2QNM6SHP"
  };

// Initialiser Firebase
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);
const storage = getStorage(app);

// Globale variabler
let currentSessionId = null;
let myVoteCount = 0;
let chartInstance = null;

// --- DOM ELEMENTER ---
const views = {
    landing: document.getElementById('landing-page'),
    admin: document.getElementById('admin-dashboard'),
    student: document.getElementById('student-view')
};

// --- AUTENTISERING & NAVIGASJON ---

// Sjekk login status
onAuthStateChanged(auth, (user) => {
    if (user) {
        showView('admin');
        loadHistory();
    } else {
        showView('landing');
    }
});

document.getElementById('admin-login-btn').onclick = () => {
    document.getElementById('login-modal').classList.remove('hidden');
};

document.getElementById('perform-login').onclick = () => {
    const email = document.getElementById('email').value;
    const pwd = document.getElementById('password').value;
    signInWithEmailAndPassword(auth, email, pwd)
        .then(() => document.getElementById('login-modal').classList.add('hidden'))
        .catch(err => alert("Feil: " + err.message));
};

function showView(viewName) {
    Object.values(views).forEach(el => el.classList.add('hidden'));
    views[viewName].classList.remove('hidden');
}

// --- TEMA & UI ---
document.getElementById('theme-toggle').onclick = () => {
    document.body.classList.toggle('dark-mode');
};

document.getElementById('bg-upload-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if(!file) return;
    
    // Her laster vi opp til Firebase Storage
    const storageRef = sRef(storage, 'backgrounds/' + Date.now());
    await uploadBytes(storageRef, file);
    const url = await getDownloadURL(storageRef);
    
    document.getElementById('app-background').style.backgroundImage = `url('${url}')`;
    // Lagre preferanse i DB hvis ønskelig
});

// --- ADMIN FUNKSJONALITET ---

// Legg til alternativ i skjema
document.getElementById('add-option-btn').onclick = () => {
    const container = document.getElementById('options-container');
    const div = document.createElement('div');
    div.className = 'option-row';
    div.innerHTML = `
        <input type="text" placeholder="Svaralternativ" class="opt-text">
        <input type="color" value="#4a90e2" class="opt-color">
        <input type="file" accept="image/*" class="opt-img-input">
        <button onclick="this.parentElement.remove()">X</button>
    `;
    container.appendChild(div);
};

// Start Avstemning
document.getElementById('launch-poll-btn').onclick = async () => {
    const question = document.getElementById('question-text').value;
    const chartType = document.getElementById('chart-type').value;
    const maxVotes = document.getElementById('max-votes').value;
    
    // Generer kodeord (6 siffer)
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Samle alternativer
    const optionsData = [];
    const optRows = document.querySelectorAll('.option-row');
    
    for (let row of optRows) {
        const text = row.querySelector('.opt-text').value;
        const color = row.querySelector('.opt-color').value;
        const fileInput = row.querySelector('.opt-img-input');
        
        let imgUrl = "";
        if (fileInput.files[0]) {
            const imgRef = sRef(storage, `options/${Date.now()}_${fileInput.files[0].name}`);
            await uploadBytes(imgRef, fileInput.files[0]);
            imgUrl = await getDownloadURL(imgRef);
        }

        optionsData.push({ text, color, imgUrl, votes: 0 });
    }

    // Lagre til database
    const newSessionRef = push(ref(db, 'sessions'));
    currentSessionId = newSessionRef.key;
    
    await set(newSessionRef, {
        code: code,
        question: question,
        options: optionsData,
        chartType: chartType,
        maxVotes: maxVotes,
        active: true,
        timestamp: Date.now()
    });

    // Oppdater UI
    document.getElementById('creation-view').classList.add('hidden');
    document.getElementById('live-results-view').classList.remove('hidden');
    document.getElementById('display-code').innerText = code;
    
    // Generer QR
    document.getElementById('qrcode').innerHTML = "";
    new QRCode(document.getElementById('qrcode'), {
        text: window.location.href + "?code=" + code,
        width: 128, height: 128
    });

    // Lytt på resultater
    listenToResults(currentSessionId);
};

function listenToResults(sessionId) {
    onValue(ref(db, `sessions/${sessionId}`), (snapshot) => {
        const data = snapshot.val();
        if(!data) return;
        renderChart(data);
    });
}

function renderChart(data) {
    const ctx = document.getElementById('results-chart').getContext('2d');
    const labels = data.options.map(o => o.text);
    const votes = data.options.map(o => o.votes || 0);
    const colors = data.options.map(o => o.color);

    if (chartInstance) chartInstance.destroy();

    chartInstance = new Chart(ctx, {
        type: data.chartType,
        data: {
            labels: labels,
            datasets: [{
                label: '# Stemmer',
                data: votes,
                backgroundColor: colors,
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
}

// --- ELEV FUNKSJONALITET ---

// Bli med via URL parameter
const urlParams = new URLSearchParams(window.location.search);
const urlCode = urlParams.get('code');
if (urlCode) {
    document.getElementById('session-code-input').value = urlCode;
    joinSession(urlCode);
}

document.getElementById('join-btn').onclick = () => {
    const code = document.getElementById('session-code-input').value;
    joinSession(code);
};

function joinSession(code) {
    // Finn session ID basert på kode (Dette krever en query i en ekte app, her itererer vi enkelt for demo)
    onValue(ref(db, 'sessions'), (snapshot) => {
        const sessions = snapshot.val();
        let foundId = null;
        let sessionData = null;

        for (let id in sessions) {
            if (sessions[id].code == code && sessions[id].active) {
                foundId = id;
                sessionData = sessions[id];
                break;
            }
        }

        if (foundId) {
            currentSessionId = foundId;
            showView('student');
            renderStudentView(sessionData);
            // Lytt til endringer (hvis lærer endrer spørsmål eller starter ny runde)
            onValue(ref(db, `sessions/${foundId}`), (snap) => {
                renderStudentView(snap.val());
            });
        } else {
            document.getElementById('join-error').innerText = "Fant ingen aktiv sesjon med denne koden.";
        }
    }, { onlyOnce: true });
}

function renderStudentView(data) {
    if (!data || !data.active) {
        document.getElementById('student-question').innerText = "Sesjonen er avsluttet.";
        document.getElementById('student-options').innerHTML = "";
        return;
    }

    document.getElementById('student-question').innerText = data.question;
    const container = document.getElementById('student-options');
    container.innerHTML = "";

    data.options.forEach((opt, index) => {
        const btn = document.createElement('div');
        btn.className = 'vote-card';
        btn.innerHTML = `
            ${opt.imgUrl ? `<img src="${opt.imgUrl}">` : ''}
            <h3>${opt.text}</h3>
        `;
        btn.onclick = () => submitVote(index, data);
        container.appendChild(btn);
    });
}

function submitVote(optionIndex, data) {
    if (myVoteCount >= data.maxVotes) {
        document.getElementById('vote-status').innerText = "Du har brukt dine stemmer.";
        return;
    }

    // Transaksjon for å øke stemmetallet sikkert
    const optRef = ref(db, `sessions/${currentSessionId}/options/${optionIndex}/votes`);
    // Enkel inkrementering (i produksjon bør man bruke transaction)
    const currentVotes = data.options[optionIndex].votes || 0;
    update(ref(db, `sessions/${currentSessionId}/options/${optionIndex}`), {
        votes: currentVotes + 1
    });

    myVoteCount++;
    document.getElementById('vote-status').innerText = "Stemme registrert!";
}

// Laste historikk for admin
function loadHistory() {
    const list = document.getElementById('history-list');
    onValue(ref(db, 'sessions'), (snapshot) => {
        list.innerHTML = "";
        const data = snapshot.val();
        // Sorter og vis de siste
    });
}