// Importer Firebase funksjoner (CDN versjon)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-app.js";
import { getDatabase, ref, set, onValue, push, update } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-database.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js";
import { getStorage, ref as sRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-storage.js";

// --- KONFIGURASJON (ERSTATT MED DIN EGEN FRA FIREBASE CONSOLE) ---
const firebaseConfig = {
    apiKey: "AIzaSyDFb5GK8bUZP2ZpMByG9-X1JiL-jNPFrKY",
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
    const loginBtn = document.getElementById('admin-login-btn');
    const moreMenuContainer = document.querySelector('.more-menu-container');
    const logoutBtn = document.getElementById('logout-btn');

    if (user) {
        showView('admin');
        loadHistory();
        if (loginBtn) loginBtn.classList.add('hidden');
        if (moreMenuContainer) moreMenuContainer.classList.remove('hidden');
        if (logoutBtn) logoutBtn.classList.remove('hidden');
    } else {
        showView('landing');
        if (loginBtn) loginBtn.classList.remove('hidden');
        // We might want to keep more menu visible even if not logged in (for theme toggle), 
        // but maybe hide the background change if strictly admin? 
        // For now, let's keep it visible but maybe specific items could be hidden if we wanted granularity.
        // User asked for "more menu" generally.
        if (moreMenuContainer) moreMenuContainer.classList.remove('hidden'); 
        if (logoutBtn) logoutBtn.classList.add('hidden');
    }
});

document.getElementById('admin-login-btn').onclick = () => {
    document.getElementById('login-modal').classList.remove('hidden');
};

const loginForm = document.getElementById('login-form');
if (loginForm) {
    loginForm.onsubmit = (e) => {
        e.preventDefault();
        const email = document.getElementById('email').value;
        const pwd = document.getElementById('current-password').value;
        signInWithEmailAndPassword(auth, email, pwd)
            .then(() => {
                document.getElementById('login-modal').classList.add('hidden');
                loginForm.reset();
            })
            .catch(err => {
                console.error(err);
                if (err.message.includes("identity-toolkit-api")) {
                    alert("Feil: API-et er ikke aktivert i Firebase Console. Kontakt administrator.");
                } else {
                    alert("Kunne ikke logge inn: " + err.message);
                }
            });
    };
}

// Close modal logic
const loginModal = document.getElementById('login-modal');
const modalCloseBtn = loginModal.querySelector('.close');
if (modalCloseBtn) {
    modalCloseBtn.onclick = () => loginModal.classList.add('hidden');
}
// Close on outside click
loginModal.onclick = (e) => {
    if (e.target === loginModal) loginModal.classList.add('hidden');
};

// Logout logic
const logoutBtn = document.getElementById('logout-btn');
if (logoutBtn) {
    logoutBtn.onclick = () => {
        auth.signOut().then(() => {
            if (moreDropdown) moreDropdown.classList.add('hidden');
        }).catch(err => alert("Kunne ikke logge ut: " + err.message));
    };
}

// TMDB API key storage
const tmdbKeyInput = document.getElementById('tmdb-key-input');
if (tmdbKeyInput) {
    tmdbKeyInput.value = localStorage.getItem('tmdb_api_key') || '';
    tmdbKeyInput.addEventListener('input', (e) => {
        localStorage.setItem('tmdb_api_key', e.target.value.trim());
    });
}

function showView(viewName) {
    Object.values(views).forEach(el => el.classList.add('hidden'));
    views[viewName].classList.remove('hidden');
}

// --- TEMA & UI ---
// --- TEMA & UI ---
const moreMenuBtn = document.getElementById('more-menu-btn');
const moreDropdown = document.getElementById('more-dropdown');
const themeToggleBtn = document.getElementById('theme-toggle');

if (moreMenuBtn) {
    moreMenuBtn.onclick = (e) => {
        e.stopPropagation(); // Prevent closing immediately
        moreDropdown.classList.toggle('hidden');
    };
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
    if (moreDropdown && !moreDropdown.classList.contains('hidden')) {
        if (!moreDropdown.contains(e.target) && e.target !== moreMenuBtn) {
            moreDropdown.classList.add('hidden');
        }
    }
});

if (themeToggleBtn) {
    themeToggleBtn.onclick = () => {
        document.body.classList.toggle('dark-mode');
        // Update icon based on mode if desired, or keep generic
    };
}

document.getElementById('bg-upload-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Immediate local preview
    const reader = new FileReader();
    reader.onload = (e) => {
        document.getElementById('app-background').style.backgroundImage = `url('${e.target.result}')`;
    };
    reader.readAsDataURL(file);

    // Her laster vi opp til Firebase Storage (behold logikk for persistens)
    try {
        const storageRef = sRef(storage, 'backgrounds/' + Date.now());
        await uploadBytes(storageRef, file);
        const url = await getDownloadURL(storageRef);
        // Oppdater med faktisk URL etter upload (sikrer at den virker for alle)
        // document.getElementById('app-background').style.backgroundImage = `url('${url}')`;
        // Lagre preferanse i DB hvis ønskelig
    } catch (err) {
        console.error("Upload failed", err);
        alert("Kunne ikke lagre bakgrunn, men lokal visning er aktiv.");
    }
});

// --- ADMIN FUNKSJONALITET ---

//// Reusable function to add option row
function createOptionRow(text = "", color = "#4a90e2", imgUrl = "") {
    const container = document.getElementById('options-container');
    const div = document.createElement('div');
    div.className = 'option-row';
    if (imgUrl) {
        div.dataset.tmdbImgUrl = imgUrl;
    }
    div.innerHTML = `
        <div class="opt-preview" style="width: 40px; height: 40px; border-radius: 4px; border: 2px solid ${color}; background-size: cover; background-position: center; ${imgUrl ? `background-image: url('${imgUrl}');` : ''}"></div>
        <input type="text" placeholder="Svaralternativ" class="opt-text" value="${text}">
        <label title="Velg farge for dette alternativet" class="color-picker-label">
            <input type="color" value="${color}" class="opt-color">
            <span class="material-icons-round" style="font-size: 1.2rem; cursor: pointer;">palette</span>
        </label>
        <input type="file" accept="image/*" class="opt-img-input" title="Last opp bilde (valgfritt)">
        <button onclick="this.parentElement.remove()" class="icon-btn-danger" title="Fjern alternativ"><span class="material-icons-round">close</span></button>
    `;
    
    // Add listeners for preview
    const colorInput = div.querySelector('.opt-color');
    const fileInput = div.querySelector('.opt-img-input');
    const previewDiv = div.querySelector('.opt-preview');

    colorInput.addEventListener('input', (e) => {
        previewDiv.style.borderColor = e.target.value;
    });

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            delete div.dataset.tmdbImgUrl;
            const reader = new FileReader();
            reader.onload = (ev) => {
                previewDiv.style.backgroundImage = `url('${ev.target.result}')`;
            };
            reader.readAsDataURL(file);
        } else {
            previewDiv.style.backgroundImage = imgUrl ? `url('${imgUrl}')` : '';
            if (imgUrl) {
                div.dataset.tmdbImgUrl = imgUrl;
            }
        }
    });

    container.appendChild(div);
}

// Legg til alternativ i skjema
document.getElementById('add-option-btn').onclick = () => {
    createOptionRow();
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

        let imgUrl = row.dataset.tmdbImgUrl || "";
        if (!imgUrl && fileInput && fileInput.files[0]) {
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
        if (!data) return;
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
        btn.style.borderColor = opt.color; // Use custom color
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

// --- FILM-POOL & TMDB INTEGRASJON ---

let moviePool = [];
try {
    moviePool = JSON.parse(localStorage.getItem('movie_pool')) || [];
} catch (e) {
    moviePool = [];
}

const PRESET_COLORS = ['#ff6b6b', '#4a90e2', '#2ecc71', '#f1c40f'];

function saveMoviePool() {
    localStorage.setItem('movie_pool', JSON.stringify(moviePool));
    renderMoviePool();
}

function renderMoviePool() {
    const poolList = document.getElementById('movie-pool-list');
    const poolCountSpan = document.getElementById('pool-count');
    const populateBtn = document.getElementById('populate-poll-btn');
    
    if (!poolList) return;
    
    poolList.innerHTML = '';
    
    if (moviePool.length === 0) {
        poolList.innerHTML = '<div class="empty-pool-message">Ingen filmer lagt til ennå. Søk over for å legge til filmer i listen din.</div>';
        poolCountSpan.innerText = '0';
        populateBtn.disabled = true;
        return;
    }
    
    poolCountSpan.innerText = moviePool.length;
    
    moviePool.forEach((movie, index) => {
        const item = document.createElement('div');
        item.className = 'pool-item';
        if (movie.selected) {
            item.classList.add('selected');
        }
        
        item.innerHTML = `
            <input type="checkbox" class="pool-item-checkbox" ${movie.selected ? 'checked' : ''} data-index="${index}">
            ${movie.posterUrl ? `<img src="${movie.posterUrl}" class="pool-item-poster" alt="${movie.title}">` : '<div class="pool-item-poster" style="background:#eee; display:flex; align-items:center; justify-content:center;"><span class="material-icons-round">movie</span></div>'}
            <span class="pool-item-title">${movie.title}</span>
            <button class="pool-item-remove" data-index="${index}" title="Fjern film"><span class="material-icons-round">delete</span></button>
        `;
        
        // Toggle selection
        item.querySelector('.pool-item-checkbox').addEventListener('change', (e) => {
            moviePool[index].selected = e.target.checked;
            localStorage.setItem('movie_pool', JSON.stringify(moviePool));
            
            // Visual feedback
            if (e.target.checked) {
                item.classList.add('selected');
            } else {
                item.classList.remove('selected');
            }
            
            updatePopulateButtonState();
        });
        
        // Remove item
        item.querySelector('.pool-item-remove').addEventListener('click', () => {
            moviePool.splice(index, 1);
            saveMoviePool();
        });
        
        poolList.appendChild(item);
    });
    
    updatePopulateButtonState();
}

function updatePopulateButtonState() {
    const selectedCount = moviePool.filter(m => m.selected).length;
    const populateBtn = document.getElementById('populate-poll-btn');
    if (populateBtn) {
        populateBtn.disabled = selectedCount !== 4;
        if (selectedCount === 4) {
            populateBtn.title = "Klikk for å fylle avstemningen med de 4 valgte filmene";
        } else {
            populateBtn.title = "Du må velge nøyaktig 4 filmer i poolen for å fylle avstemningen";
        }
    }
}

// Clear pool
const clearPoolBtn = document.getElementById('clear-pool-btn');
if (clearPoolBtn) {
    clearPoolBtn.onclick = () => {
        if (confirm("Er du sikker på at du vil tømme hele film-poolen?")) {
            moviePool = [];
            saveMoviePool();
        }
    };
}

// Search TMDB
const searchInput = document.getElementById('tmdb-search-input');
const searchBtn = document.getElementById('tmdb-search-btn');
const searchResults = document.getElementById('tmdb-search-results');

if (searchBtn && searchInput) {
    const performSearch = async () => {
        const query = searchInput.value.trim();
        if (!query) return;
        
        const apiKey = localStorage.getItem('tmdb_api_key');
        if (!apiKey) {
            alert("Vennligst legg inn en TMDB API-nøkkel (v3) i 'Mer'-menyen oppe til høyre først. Du kan opprette en gratis profil på themoviedb.org og hente nøkkelen der.");
            return;
        }
        
        searchBtn.disabled = true;
        searchBtn.innerHTML = '<span class="material-icons-round rotate" style="animation: spin 1s linear infinite;">sync</span>';
        
        try {
            const url = `https://api.themoviedb.org/3/search/movie?api_key=${apiKey}&query=${encodeURIComponent(query)}&language=no-NO`;
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error("Klarte ikke å hente resultater fra TMDB. Sjekk at API-nøkkelen er gyldig.");
            }
            const data = await response.json();
            
            renderSearchResults(data.results || []);
        } catch (err) {
            alert(err.message);
            searchResults.classList.add('hidden');
        } finally {
            searchBtn.disabled = false;
            searchBtn.innerHTML = '<span class="material-icons-round">search</span>';
        }
    };
    
    searchBtn.onclick = performSearch;
    searchInput.onkeypress = (e) => {
        if (e.key === 'Enter') {
            performSearch();
        }
    };
}

// Add CSS spin animation helper if not present
const styleNode = document.createElement('style');
styleNode.innerHTML = `
@keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
}
`;
document.head.appendChild(styleNode);

function renderSearchResults(results) {
    if (!searchResults) return;
    
    searchResults.innerHTML = '';
    searchResults.classList.remove('hidden');
    
    if (results.length === 0) {
        searchResults.innerHTML = '<div style="padding: 15px; font-size: 0.9rem; opacity: 0.7; text-align: center;">Ingen filmer funnet.</div>';
        return;
    }
    
    // Take top 5 results
    results.slice(0, 5).forEach(movie => {
        const item = document.createElement('div');
        item.className = 'search-result-item';
        
        const posterUrl = movie.poster_path ? `https://image.tmdb.org/t/p/w92${movie.poster_path}` : '';
        const fullPosterUrl = movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : '';
        const year = movie.release_date ? movie.release_date.substring(0, 4) : 'Ukjent år';
        
        item.innerHTML = `
            ${posterUrl ? `<img src="${posterUrl}" alt="${movie.title}">` : '<div style="width:35px; height:50px; background:#ddd; display:flex; align-items:center; justify-content:center; border-radius:4px;"><span class="material-icons-round" style="font-size:1.2rem;">movie</span></div>'}
            <div class="search-result-info">
                <span class="search-result-title">${movie.title}</span>
                <span class="search-result-year">${year}</span>
            </div>
            <span class="material-icons-round" style="color: var(--primary);">add_circle</span>
        `;
        
        item.onclick = () => {
            // Check if already in pool
            if (moviePool.some(m => m.id === movie.id)) {
                alert("Filmen er allerede lagt til i poolen din.");
                return;
            }
            
            moviePool.push({
                id: movie.id,
                title: movie.title,
                posterUrl: fullPosterUrl,
                selected: false
            });
            
            saveMoviePool();
            searchInput.value = '';
            searchResults.classList.add('hidden');
        };
        
        searchResults.appendChild(item);
    });
}

// Close search results when clicking outside
document.addEventListener('click', (e) => {
    if (searchResults && !searchResults.classList.contains('hidden')) {
        if (!searchResults.contains(e.target) && e.target !== searchInput && e.target !== searchBtn) {
            searchResults.classList.add('hidden');
        }
    }
});

// Populate poll options from Movie Pool
const populateBtn = document.getElementById('populate-poll-btn');
if (populateBtn) {
    populateBtn.onclick = () => {
        const selectedMovies = moviePool.filter(m => m.selected);
        if (selectedMovies.length !== 4) {
            alert("Du må velge nøyaktig 4 filmer fra poolen.");
            return;
        }
        
        const container = document.getElementById('options-container');
        if (!container) return;
        
        // Ask for confirmation if there are already options in the form
        if (container.children.length > 0 && !confirm("Dette vil erstatte alle gjeldende alternativer i skjemaet. Fortsette?")) {
            return;
        }
        
        // Set standard film-question if empty
        const questionInput = document.getElementById('question-text');
        if (questionInput && !questionInput.value.trim()) {
            questionInput.value = "Hvilken film skal vi se på siste skoledag?";
        }
        
        container.innerHTML = '';
        
        // Add the 4 selected movies
        selectedMovies.forEach((movie, i) => {
            createOptionRow(movie.title, PRESET_COLORS[i], movie.posterUrl);
        });
        
        // Uncheck them from pool so they are ready for next rounds, or keep checked?
        // User says "4 filmer skal møtes i en avstemning av gangen. Vi skal stemme over ganske mange filmer."
        // Keeping them checked allows easy re-selection, but unchecking encourages moving to next group.
        // Let's uncheck them so the next 4 can be selected easily!
        moviePool.forEach(m => {
            if (m.selected) m.selected = false;
        });
        saveMoviePool();
    };
}

// Initial render
renderMoviePool();