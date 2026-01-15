// ==================== GALERİ SAYFASI - HİYERARŞİK FİLTRE ==================== //

// ==================== IndexedDB Helper (Büyük veri depolama) ==================== //
const DB_NAME = 'HizmetlerDB';
const DB_VERSION = 1;
const STORE_NAME = 'excelData';

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
        };
    });
}

async function loadFromIndexedDB(key) {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const request = tx.objectStore(STORE_NAME).get(key);
            request.onsuccess = () => resolve(request.result?.data);
            request.onerror = () => reject(request.error);
        });
    } catch (e) {
        console.warn('IndexedDB erişim hatası:', e.message);
        return null;
    }
}

// ==================== VERİ KAYNAKLARI ==================== //
let allLocations = [];
let allServices = [];
let allMudurlukler = [];
let allTurler = [];
let serviceMudurlukMap = {}; // Hizmet -> Müdürlük
let hizmetTurlerMap = {};    // Hizmet -> Türler[]
let bggVeriler = [];
let allRawData = [];
let selectedReportMonth = null;

// Wizard state
let currentStep = 'customize';

// ==================== HİYERARŞİK FİLTRE CONFIG ==================== //
// Ana veri yapısı: Her müdürlük, hizmet ve tür için seçim durumu
let filterConfig = {
    mudurlukler: {},  // { müdürlükAdı: { selected: true, hizmetler: { hizmetAdı: { selected: true, turler: { türAdı: true } } } } }
};

// Expand durumları (UI için)
let expandState = {
    mudurlukler: {}, // { müdürlükAdı: true/false }
    hizmetler: {}    // { "müdürlükAdı|hizmetAdı": true/false }
};

// ==================== TARİH FİLTRELEME ==================== //

function filterDataByReportMonth() {
    if (!selectedReportMonth || allRawData.length === 0) return;

    const targetYear = selectedReportMonth.year;
    const targetMonth = selectedReportMonth.month;

    console.log(`Filtreleme: ${targetYear} yılı ${targetMonth + 1}. ay seçildi`);

    bggVeriler = allRawData.filter(r => {
        const sonTarih = parseSonTarih(r.sonTarih);
        if (!sonTarih) return false;

        const dataYear = sonTarih.getFullYear();
        const dataMonth = sonTarih.getMonth();
        const veriAraligi = (r.veriAraligi || '').toUpperCase();

        if (dataYear > targetYear) return false;
        if (dataYear === targetYear && dataMonth > targetMonth) return false;

        if (veriAraligi === 'BGG' || veriAraligi === 'AYLIK') {
            return dataYear === targetYear && dataMonth === targetMonth;
        }

        if (veriAraligi === 'KÜMÜLATİF' || veriAraligi === 'KUMULATIF') {
            if (dataYear === targetYear) return dataMonth === targetMonth;
            if (dataYear < targetYear) return dataMonth === 11;
        }

        return dataYear === targetYear && dataMonth === targetMonth;
    });

    console.log(`Filtrelenen veri sayısı: ${bggVeriler.length}`);
}

function parseSonTarih(dateInput) {
    if (!dateInput) return null;
    if (dateInput instanceof Date) return isNaN(dateInput) ? null : dateInput;
    if (typeof dateInput === 'number' && dateInput > 25569 && dateInput < 100000) {
        return new Date(Math.round((dateInput - 25569) * 86400 * 1000));
    }
    if (typeof dateInput === 'string') {
        const str = dateInput.trim();
        const trMatch = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
        if (trMatch) {
            const [, d, m, y] = trMatch;
            return new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
        }
        const date = new Date(str);
        return isNaN(date) ? null : date;
    }
    return null;
}

// ==================== WIZARD YÖNETİMİ ==================== //

function showStep(stepName) {
    currentStep = stepName;
    document.querySelectorAll('.wizard-step').forEach(step => step.classList.remove('active'));

    const wizardContainer = document.getElementById('wizard-container');
    const galleryContainer = document.getElementById('gallery-container');

    if (stepName === 'gallery') {
        wizardContainer.style.display = 'none';
        galleryContainer.style.display = 'block';
        renderGallery();
    } else {
        const autoStyle = document.getElementById('auto-generate-style');
        if (autoStyle) autoStyle.remove();

        wizardContainer.style.display = 'flex';
        galleryContainer.style.display = 'none';

        const stepElement = document.getElementById(`step-${stepName}`);
        if (stepElement) stepElement.classList.add('active');
    }
}

function goToGallery() {
    saveConfig();
    showStep('gallery');
}

// ==================== EXCEL VERİ YÜKLEME ==================== //

async function loadExcelData() {
    try {
        let data = [];

        const indexedDBData = await loadFromIndexedDB('hizmet_rawdata');

        if (indexedDBData && indexedDBData.length > 0) {
            console.log('✅ IndexedDB\'den geçici veri bulundu:', indexedDBData.length, 'kayıt');
            data = indexedDBData.map(r => ({
                mudurluk: (r.mudurluk || '').toString().trim(),
                hizmet: (r.hizmet || '').toString().trim(),
                tur: (r.tur || '').toString().trim(),
                lokasyon: (r.lokasyon || 'İstanbul Geneli').toString().trim(),
                veriAraligi: (r.veriAraligi || 'BGG').toString().trim().toLocaleUpperCase('tr-TR'),
                deger: parseFloat(r.deger) || 0,
                sonTarih: r.tarih ? new Date(r.tarih) : null
            })).filter(r => r.mudurluk && r.hizmet);
        } else {
            console.log('📁 Varsayılan veri.xlsx yükleniyor...');
            const res = await fetch('hizmet-verileri/veri.xlsx');
            const buf = await res.arrayBuffer();
            const wb = XLSX.read(buf, { type: 'array', cellDates: true });

            const hizSheet = wb.Sheets['Hizmetler'];
            if (hizSheet) {
                const rows = XLSX.utils.sheet_to_json(hizSheet, { cellDates: true });
                data = rows.map(r => ({
                    mudurluk: (r['Müdürlük'] || '').toString().trim(),
                    hizmet: (r['Hizmet Başlığı'] || '').toString().trim(),
                    tur: (r['Tür'] || '').toString().trim(),
                    lokasyon: (r['Lokasyon'] || '').toString().trim(),
                    veriAraligi: (r['Veri Aralığı'] || '').toString().trim().toLocaleUpperCase('tr-TR'),
                    deger: parseFloat(r['Değer']) || 0,
                    sonTarih: r['Son Tarih']
                })).filter(r => r.mudurluk && r.hizmet);
            }
        }

        if (data.length > 0) {
            allRawData = data;

            // Lokasyonları çıkar
            const lokasyonSet = new Set();
            data.forEach(r => {
                if (r.lokasyon && r.lokasyon !== 'Diğer') lokasyonSet.add(r.lokasyon);
            });
            allLocations = Array.from(lokasyonSet).sort((a, b) => {
                if (a === 'İstanbul Geneli') return -1;
                if (b === 'İstanbul Geneli') return 1;
                return a.localeCompare(b, 'tr');
            });

            // Müdürlükleri çıkar
            const mudurlukSet = new Set();
            data.forEach(r => {
                if (r.mudurluk) mudurlukSet.add(r.mudurluk);
            });
            allMudurlukler = Array.from(mudurlukSet).sort((a, b) => a.localeCompare(b, 'tr'));

            // Hizmetleri ve ilişkileri çıkar
            const hizmetMap = {};
            const hizmetTurMap = {};
            data.forEach(r => {
                if (!hizmetMap[r.hizmet]) hizmetMap[r.hizmet] = r.mudurluk;
                if (r.hizmet && r.tur) {
                    if (!hizmetTurMap[r.hizmet]) hizmetTurMap[r.hizmet] = new Set();
                    hizmetTurMap[r.hizmet].add(r.tur);
                }
            });
            serviceMudurlukMap = hizmetMap;
            hizmetTurlerMap = {};
            Object.keys(hizmetTurMap).forEach(h => {
                hizmetTurlerMap[h] = Array.from(hizmetTurMap[h]).sort((a, b) => a.localeCompare(b, 'tr'));
            });
            allServices = Object.keys(hizmetMap).sort((a, b) => a.localeCompare(b, 'tr'));

            // Türleri çıkar
            const turSet = new Set();
            data.forEach(r => {
                if (r.tur) turSet.add(r.tur);
            });
            allTurler = Array.from(turSet).sort((a, b) => a.localeCompare(b, 'tr'));

            console.log('Veriler yüklendi:', {
                lokasyonlar: allLocations.length,
                mudurlukler: allMudurlukler.length,
                hizmetler: allServices.length,
                turler: allTurler.length
            });
        }

        return true;
    } catch (error) {
        console.error('Veri yükleme hatası:', error);
        return false;
    }
}

// ==================== HİYERARŞİK CONFIG YÖNETİMİ ==================== //

function getDefaultConfig() {
    const config = { mudurlukler: {} };

    allMudurlukler.forEach(mud => {
        config.mudurlukler[mud] = {
            selected: true,
            hizmetler: {}
        };

        // Bu müdürlüğün hizmetlerini bul
        const hizmetler = allServices.filter(h => serviceMudurlukMap[h] === mud);
        hizmetler.forEach(hizmet => {
            config.mudurlukler[mud].hizmetler[hizmet] = {
                selected: true,
                turler: {}
            };

            // Bu hizmetin türlerini bul
            const turler = hizmetTurlerMap[hizmet] || [];
            turler.forEach(tur => {
                config.mudurlukler[mud].hizmetler[hizmet].turler[tur] = true;
            });
        });
    });

    return config;
}

function loadConfig() {
    try {
        const saved = localStorage.getItem('hierarchicalFilterConfig');
        if (saved) {
            filterConfig = JSON.parse(saved);
            console.log('✅ Config localStorage\'dan yüklendi');

            // Yeni eklenen müdürlük/hizmet/türleri config'e ekle
            allMudurlukler.forEach(mud => {
                if (!filterConfig.mudurlukler[mud]) {
                    filterConfig.mudurlukler[mud] = { selected: true, hizmetler: {} };
                }
                const hizmetler = allServices.filter(h => serviceMudurlukMap[h] === mud);
                hizmetler.forEach(hizmet => {
                    if (!filterConfig.mudurlukler[mud].hizmetler[hizmet]) {
                        filterConfig.mudurlukler[mud].hizmetler[hizmet] = { selected: true, turler: {} };
                    }
                    const turler = hizmetTurlerMap[hizmet] || [];
                    turler.forEach(tur => {
                        if (filterConfig.mudurlukler[mud].hizmetler[hizmet].turler[tur] === undefined) {
                            filterConfig.mudurlukler[mud].hizmetler[hizmet].turler[tur] = true;
                        }
                    });
                });
            });
        } else {
            filterConfig = getDefaultConfig();
        }
    } catch (e) {
        console.warn('Config yüklenemedi:', e);
        filterConfig = getDefaultConfig();
    }
}

function saveConfig() {
    localStorage.setItem('hierarchicalFilterConfig', JSON.stringify(filterConfig));

    // Ayrıca eski serviceConfig formatını da güncelle (app.js uyumluluğu için)
    const legacyConfig = {
        mudurlukler: {},
        services: {},
        turler: {},
        hizmetTurler: {}
    };

    // Müdürlükler
    allMudurlukler.forEach(mud => {
        legacyConfig.mudurlukler[mud] = filterConfig.mudurlukler[mud]?.selected !== false;
    });

    // Hizmetler ve türler
    Object.keys(filterConfig.mudurlukler).forEach(mud => {
        const mudConfig = filterConfig.mudurlukler[mud];
        if (!mudConfig.hizmetler) return;

        Object.keys(mudConfig.hizmetler).forEach(hizmet => {
            const hizConfig = mudConfig.hizmetler[hizmet];
            // Eğer müdürlük veya hizmet kapalıysa, legacy'de hizmeti kapalı say
            const hizmetActive = mudConfig.selected !== false && hizConfig.selected !== false;
            legacyConfig.services[hizmet] = hizmetActive;

            // Hizmetin türleri
            legacyConfig.hizmetTurler[hizmet] = {};
            if (hizConfig.turler) {
                Object.keys(hizConfig.turler).forEach(tur => {
                    legacyConfig.hizmetTurler[hizmet][tur] = hizConfig.turler[tur] !== false;
                });
            }
        });
    });

    // Global türler (toplu tür seçimleri)
    allTurler.forEach(tur => {
        // Tür en az bir hizmette aktifse true
        let turActive = false;
        Object.keys(filterConfig.mudurlukler).forEach(mud => {
            const mudConfig = filterConfig.mudurlukler[mud];
            if (mudConfig.selected === false || !mudConfig.hizmetler) return;
            Object.keys(mudConfig.hizmetler).forEach(hizmet => {
                const hizConfig = mudConfig.hizmetler[hizmet];
                if (hizConfig.selected === false) return;
                if (hizConfig.turler && hizConfig.turler[tur] !== false) {
                    turActive = true;
                }
            });
        });
        legacyConfig.turler[tur] = turActive;
    });

    localStorage.setItem('serviceConfig', JSON.stringify(legacyConfig));
    console.log('✅ Config kaydedildi (hem yeni hem legacy format)');
}

function resetConfig() {
    filterConfig = getDefaultConfig();
    expandState = { mudurlukler: {}, hizmetler: {} };
    saveConfig();
}

// ==================== UI RENDER ==================== //

function renderHierarchicalFilter() {
    const container = document.getElementById('hierarchical-list');

    if (allMudurlukler.length === 0) {
        container.innerHTML = '<div style="text-align: center; padding: 2rem; color: #94a3b8;">Müdürlük bulunamadı</div>';
        return;
    }

    let html = '';

    allMudurlukler.forEach(mudurluk => {
        const mudConfig = filterConfig.mudurlukler[mudurluk] || { selected: true, hizmetler: {} };
        const isMudExpanded = expandState.mudurlukler[mudurluk] === true;
        const isMudSelected = mudConfig.selected !== false;

        // Bu müdürlüğün hizmet sayısı
        const hizmetler = allServices.filter(h => serviceMudurlukMap[h] === mudurluk);
        const selectedHizmetCount = hizmetler.filter(h =>
            mudConfig.hizmetler[h]?.selected !== false
        ).length;

        html += `
            <div class="mudurluk-item ${isMudExpanded ? 'expanded' : ''}" data-mudurluk="${escapeHtml(mudurluk)}">
                <div class="mudurluk-header">
                    <span class="expand-icon" onclick="toggleMudurlukExpand('${escapeJs(mudurluk)}')">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="9 18 15 12 9 6"></polyline>
                        </svg>
                    </span>
                    <input type="checkbox" class="mudurluk-checkbox" 
                           ${isMudSelected ? 'checked' : ''} 
                           onchange="toggleMudurlukSelection('${escapeJs(mudurluk)}', this.checked)">
                    <span class="mudurluk-name" onclick="toggleMudurlukExpand('${escapeJs(mudurluk)}')">${escapeHtml(mudurluk)}</span>
                    <span class="mudurluk-count">${selectedHizmetCount}/${hizmetler.length} hizmet</span>
                </div>
                <div class="hizmet-container">
                    ${renderHizmetList(mudurluk, hizmetler, mudConfig)}
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
    updateFilterStats();
}

function renderHizmetList(mudurluk, hizmetler, mudConfig) {
    if (hizmetler.length === 0) return '<div style="padding: 0.5rem; color: #94a3b8; font-size: 12px;">Hizmet yok</div>';

    let html = '';

    hizmetler.forEach(hizmet => {
        const hizConfig = mudConfig.hizmetler[hizmet] || { selected: true, turler: {} };
        const expandKey = `${mudurluk}|${hizmet}`;
        const isHizExpanded = expandState.hizmetler[expandKey] === true;
        const isHizSelected = hizConfig.selected !== false;

        const turler = hizmetTurlerMap[hizmet] || [];
        const selectedTurCount = turler.filter(t => hizConfig.turler[t] !== false).length;

        html += `
            <div class="hizmet-item ${isHizExpanded ? 'expanded' : ''}" data-hizmet="${escapeHtml(hizmet)}">
                <div class="hizmet-header">
                    ${turler.length > 0 ? `
                        <span class="expand-icon" onclick="toggleHizmetExpand('${escapeJs(mudurluk)}', '${escapeJs(hizmet)}')">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="9 18 15 12 9 6"></polyline>
                            </svg>
                        </span>
                    ` : '<span style="width: 16px;"></span>'}
                    <input type="checkbox" class="hizmet-checkbox" 
                           ${isHizSelected ? 'checked' : ''} 
                           onchange="toggleHizmetSelection('${escapeJs(mudurluk)}', '${escapeJs(hizmet)}', this.checked)">
                    <span class="hizmet-name" onclick="toggleHizmetExpand('${escapeJs(mudurluk)}', '${escapeJs(hizmet)}')">${escapeHtml(hizmet)}</span>
                    ${turler.length > 0 ? `<span class="hizmet-count">${selectedTurCount}/${turler.length}</span>` : ''}
                </div>
                ${turler.length > 0 ? `
                    <div class="tur-container">
                        ${renderTurList(mudurluk, hizmet, turler, hizConfig)}
                    </div>
                ` : ''}
            </div>
        `;
    });

    return html;
}

function renderTurList(mudurluk, hizmet, turler, hizConfig) {
    let html = '';

    turler.forEach(tur => {
        const isTurSelected = hizConfig.turler[tur] !== false;

        html += `
            <div class="tur-item-inline">
                <input type="checkbox" id="tur-${escapeHtml(mudurluk)}-${escapeHtml(hizmet)}-${escapeHtml(tur)}"
                       ${isTurSelected ? 'checked' : ''}
                       onchange="toggleTurSelection('${escapeJs(mudurluk)}', '${escapeJs(hizmet)}', '${escapeJs(tur)}', this.checked)">
                <label for="tur-${escapeHtml(mudurluk)}-${escapeHtml(hizmet)}-${escapeHtml(tur)}">${escapeHtml(tur)}</label>
            </div>
        `;
    });

    return html;
}

function renderTurPills() {
    const container = document.getElementById('tur-pills');

    if (allTurler.length === 0) {
        container.innerHTML = '<div style="color: #94a3b8;">Tür bulunamadı</div>';
        return;
    }

    let html = '';

    allTurler.forEach(tur => {
        // Türün genel durumu: tüm hizmetlerde aktif mi?
        const isActive = isTurActiveGlobally(tur);

        html += `
            <div class="tur-pill ${isActive ? 'active' : ''}" onclick="toggleTurGlobally('${escapeJs(tur)}')">
                ${escapeHtml(tur)}
            </div>
        `;
    });

    container.innerHTML = html;
}

function isTurActiveGlobally(tur) {
    // En az bir hizmette bu tür aktifse true
    let found = false;
    Object.keys(filterConfig.mudurlukler).forEach(mud => {
        const mudConfig = filterConfig.mudurlukler[mud];
        if (mudConfig.selected === false || !mudConfig.hizmetler) return;
        Object.keys(mudConfig.hizmetler).forEach(hizmet => {
            const hizConfig = mudConfig.hizmetler[hizmet];
            if (hizConfig.selected === false) return;
            if (hizConfig.turler && hizConfig.turler[tur] !== false) {
                found = true;
            }
        });
    });
    return found;
}

function updateFilterStats() {
    // Seçili müdürlük sayısı
    let selectedMud = 0;
    let selectedHiz = 0;
    let selectedTur = 0;

    Object.keys(filterConfig.mudurlukler).forEach(mud => {
        const mudConfig = filterConfig.mudurlukler[mud];
        if (mudConfig.selected !== false) {
            selectedMud++;
            if (mudConfig.hizmetler) {
                Object.keys(mudConfig.hizmetler).forEach(hizmet => {
                    const hizConfig = mudConfig.hizmetler[hizmet];
                    if (hizConfig.selected !== false) {
                        selectedHiz++;
                        if (hizConfig.turler) {
                            Object.keys(hizConfig.turler).forEach(tur => {
                                if (hizConfig.turler[tur] !== false) {
                                    selectedTur++;
                                }
                            });
                        }
                    }
                });
            }
        }
    });

    document.getElementById('selected-mudurluk-count').textContent = selectedMud;
    document.getElementById('selected-hizmet-count').textContent = selectedHiz;
    document.getElementById('selected-tur-count').textContent = selectedTur;
    document.getElementById('filter-stats').textContent = `${allMudurlukler.length} müdürlük, ${allServices.length} hizmet`;
}

// ==================== EVENT HANDLERS ==================== //

// Müdürlük expand/collapse
window.toggleMudurlukExpand = function (mudurluk) {
    expandState.mudurlukler[mudurluk] = !expandState.mudurlukler[mudurluk];
    renderHierarchicalFilter();
};

// Hizmet expand/collapse
window.toggleHizmetExpand = function (mudurluk, hizmet) {
    const key = `${mudurluk}|${hizmet}`;
    expandState.hizmetler[key] = !expandState.hizmetler[key];
    renderHierarchicalFilter();
};

// Müdürlük seçimi
window.toggleMudurlukSelection = function (mudurluk, checked) {
    if (!filterConfig.mudurlukler[mudurluk]) {
        filterConfig.mudurlukler[mudurluk] = { selected: true, hizmetler: {} };
    }
    filterConfig.mudurlukler[mudurluk].selected = checked;

    // Alt hizmetleri de güncelle
    if (filterConfig.mudurlukler[mudurluk].hizmetler) {
        Object.keys(filterConfig.mudurlukler[mudurluk].hizmetler).forEach(hizmet => {
            filterConfig.mudurlukler[mudurluk].hizmetler[hizmet].selected = checked;
            // Türleri de güncelle
            if (filterConfig.mudurlukler[mudurluk].hizmetler[hizmet].turler) {
                Object.keys(filterConfig.mudurlukler[mudurluk].hizmetler[hizmet].turler).forEach(tur => {
                    filterConfig.mudurlukler[mudurluk].hizmetler[hizmet].turler[tur] = checked;
                });
            }
        });
    }

    renderHierarchicalFilter();
    renderTurPills();
};

// Hizmet seçimi
window.toggleHizmetSelection = function (mudurluk, hizmet, checked) {
    if (!filterConfig.mudurlukler[mudurluk]?.hizmetler[hizmet]) return;
    filterConfig.mudurlukler[mudurluk].hizmetler[hizmet].selected = checked;

    // Alt türleri de güncelle
    if (filterConfig.mudurlukler[mudurluk].hizmetler[hizmet].turler) {
        Object.keys(filterConfig.mudurlukler[mudurluk].hizmetler[hizmet].turler).forEach(tur => {
            filterConfig.mudurlukler[mudurluk].hizmetler[hizmet].turler[tur] = checked;
        });
    }

    renderHierarchicalFilter();
    renderTurPills();
};

// Tür seçimi
window.toggleTurSelection = function (mudurluk, hizmet, tur, checked) {
    if (!filterConfig.mudurlukler[mudurluk]?.hizmetler[hizmet]?.turler) return;
    filterConfig.mudurlukler[mudurluk].hizmetler[hizmet].turler[tur] = checked;

    renderHierarchicalFilter();
    renderTurPills();
};

// Türü global olarak toggle (yardımcı araç)
window.toggleTurGlobally = function (tur) {
    const isCurrentlyActive = isTurActiveGlobally(tur);
    const newState = !isCurrentlyActive;

    // Tüm hizmetlerde bu türü güncelle
    Object.keys(filterConfig.mudurlukler).forEach(mud => {
        const mudConfig = filterConfig.mudurlukler[mud];
        if (!mudConfig.hizmetler) return;
        Object.keys(mudConfig.hizmetler).forEach(hizmet => {
            const hizConfig = mudConfig.hizmetler[hizmet];
            if (hizConfig.turler && hizConfig.turler[tur] !== undefined) {
                hizConfig.turler[tur] = newState;
            }
        });
    });

    renderHierarchicalFilter();
    renderTurPills();
};

// Tümünü seç butonu
function setupSelectAllButton() {
    const btn = document.getElementById('btn-select-all-turler');
    if (btn) {
        btn.addEventListener('click', () => {
            // Tüm türleri true yap
            allTurler.forEach(tur => {
                Object.keys(filterConfig.mudurlukler).forEach(mud => {
                    const mudConfig = filterConfig.mudurlukler[mud];
                    if (!mudConfig.hizmetler) return;
                    Object.keys(mudConfig.hizmetler).forEach(hizmet => {
                        const hizConfig = mudConfig.hizmetler[hizmet];
                        if (hizConfig.turler && hizConfig.turler[tur] !== undefined) {
                            hizConfig.turler[tur] = true;
                        }
                    });
                });
            });
            renderHierarchicalFilter();
            renderTurPills();
        });
    }
}

// Viewer açma
window.openViewer = function (location, reportMonth, turler, autoprint) {
    // Önce config'i kaydet
    saveConfig();

    // Parametreleri localStorage'a kaydet
    localStorage.setItem('viewer_location', decodeURIComponent(location));
    localStorage.setItem('viewer_reportMonth', reportMonth);
    localStorage.setItem('viewer_turler', turler);
    if (autoprint) {
        localStorage.setItem('viewer_autoprint', 'true');
    } else {
        localStorage.removeItem('viewer_autoprint');
    }

    console.log('📋 Viewer parametreleri kaydedildi:', { location, reportMonth, turler, autoprint });

    // Yeni sekmede aç
    window.open('viewer.html', '_blank');
};

// ==================== GALLERY RENDER ==================== //

function renderGallery() {
    const container = document.getElementById('report-gallery');

    // Aktif hizmetleri hesapla
    const activeServices = [];
    Object.keys(filterConfig.mudurlukler).forEach(mud => {
        const mudConfig = filterConfig.mudurlukler[mud];
        if (mudConfig.selected === false || !mudConfig.hizmetler) return;

        Object.keys(mudConfig.hizmetler).forEach(hizmet => {
            const hizConfig = mudConfig.hizmetler[hizmet];
            if (hizConfig.selected === false) return;

            // En az bir aktif türü var mı?
            const turler = Object.keys(hizConfig.turler || {});
            const hasActiveTur = turler.some(t => hizConfig.turler[t] !== false);
            if (hasActiveTur) {
                activeServices.push(hizmet);
            }
        });
    });

    // Stats güncelle
    const statsEl = document.getElementById('gallery-stats');
    const totalAktifTur = allTurler.filter(t => isTurActiveGlobally(t)).length;
    statsEl.textContent = `${allLocations.length} lokasyon, ${activeServices.length} hizmet, ${totalAktifTur} tür`;

    // Config kaydet
    saveConfig();

    // Kartları oluştur
    let html = '';
    const reportMonthInput = document.getElementById('report-month');
    const reportMonthVal = reportMonthInput ? reportMonthInput.value : '';

    allLocations.forEach(location => {
        const encodedLocation = encodeURIComponent(location);
        const aktivTurler = allTurler.filter(t => isTurActiveGlobally(t));
        const turlerParam = aktivTurler.map(t => encodeURIComponent(t)).join(',');

        html += `
            <div class="report-card">
                <div>
                    <h3 class="card-title">${escapeHtml(location)}</h3>
                </div>
                <div class="card-actions">
                    <a href="#" class="btn-view" onclick="event.preventDefault(); openViewer('${encodedLocation}', '${reportMonthVal}', '${turlerParam}', false);">
                        Görüntüle
                    </a>
                    <a href="#" class="btn-download" onclick="event.preventDefault(); openViewer('${encodedLocation}', '${reportMonthVal}', '${turlerParam}', true);">
                        İndir
                    </a>
                </div>
            </div>
        `;
    });

    if (html === '') {
        html = `
            <div class="empty-state">
                <h3>Gösterilecek rapor yok</h3>
                <p>Lütfen en az bir hizmet ve tür seçin</p>
            </div>
        `;
    }

    container.innerHTML = html;
}

// ==================== HELPER FUNCTIONS ==================== //

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function escapeJs(str) {
    return str.replace(/'/g, "\\'").replace(/"/g, '\\"');
}

// ==================== INITIALIZATION ==================== //

async function init() {
    console.log('🚀 Gallery başlatılıyor...');

    // Veri yükle
    await loadExcelData();

    // Default rapor tarihini ayarla - ANA SAYFADAN GELEN VERİ DÖNEMİNİ KULLAN
    const reportMonthInput = document.getElementById('report-month');
    if (reportMonthInput) {
        // Önce ana sayfadan gelen veri dönemini kontrol et
        let defaultYear, defaultMonth;

        const autoReportMonth = localStorage.getItem('auto_report_month'); // YYYY-MM format
        const tempDataPeriod = localStorage.getItem('temp_data_period'); // "Aralık 2025" format

        if (autoReportMonth) {
            // YYYY-MM formatından parse et
            const [y, m] = autoReportMonth.split('-');
            defaultYear = parseInt(y);
            defaultMonth = parseInt(m);
            console.log('📅 Varsayılan tarih auto_report_month\'dan alındı:', autoReportMonth);
        } else if (tempDataPeriod) {
            // "Aralık 2025" formatından parse et
            const monthNames = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
            const parts = tempDataPeriod.split(' ');
            if (parts.length === 2) {
                const monthIndex = monthNames.indexOf(parts[0]);
                if (monthIndex >= 0) {
                    defaultMonth = monthIndex + 1;
                    defaultYear = parseInt(parts[1]);
                    console.log('📅 Varsayılan tarih temp_data_period\'dan alındı:', tempDataPeriod);
                }
            }
        }

        // Eğer ana sayfadan veri yoksa, verilerden en son tarihi bul
        if (!defaultYear || !defaultMonth) {
            // allRawData'dan en son tarihi bul
            let maxDate = null;
            allRawData.forEach(r => {
                const d = parseSonTarih(r.sonTarih);
                if (d && (!maxDate || d > maxDate)) {
                    maxDate = d;
                }
            });

            if (maxDate) {
                defaultYear = maxDate.getFullYear();
                defaultMonth = maxDate.getMonth() + 1;
                console.log('📅 Varsayılan tarih verilerden alındı:', defaultYear, '-', defaultMonth);
            } else {
                // Hiçbir şey yoksa bugünün tarihi
                const now = new Date();
                defaultYear = now.getFullYear();
                defaultMonth = now.getMonth() + 1;
            }
        }

        const monthStr = String(defaultMonth).padStart(2, '0');
        reportMonthInput.value = `${defaultYear}-${monthStr}`;

        selectedReportMonth = { year: defaultYear, month: defaultMonth - 1 };
        filterDataByReportMonth();

        reportMonthInput.addEventListener('change', (e) => {
            const [y, m] = e.target.value.split('-');
            selectedReportMonth = { year: parseInt(y), month: parseInt(m) - 1 };
            filterDataByReportMonth();
        });
    }

    // Config yükle
    loadConfig();

    // UI render
    renderHierarchicalFilter();
    renderTurPills();

    // Tümünü seç butonu
    setupSelectAllButton();

    // Raporları Oluştur butonu
    const btnCreate = document.getElementById('btn-create-reports');
    if (btnCreate) {
        btnCreate.addEventListener('click', () => {
            goToGallery();
        });
    }

    // Ayarları Değiştir butonu
    const btnBack = document.getElementById('btn-back-to-wizard');
    if (btnBack) {
        btnBack.addEventListener('click', () => {
            showStep('customize');
        });
    }

    // AutoGenerate modu kontrolü
    const urlAutoGen = new URLSearchParams(window.location.search).get('autoGenerate') === 'true';
    const localAutoGen = localStorage.getItem('gallery_auto_generate') === 'true';
    if (urlAutoGen || localAutoGen) {
        localStorage.removeItem('gallery_auto_generate');
        goToGallery();
    }

    console.log('✅ Gallery hazır');
}

// Sayfa yüklenince başlat
document.addEventListener('DOMContentLoaded', init);
