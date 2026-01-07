// ==================== GALERİ SAYFASI MANTIK ==================== //

// Veri kaynakları
let allLocations = [];
let allServices = [];
let allMudurlukler = [];
let allTurler = []; // Tüm unique türler
let serviceMudurlukMap = {}; // Hizmet -> Müdürlük mapping
let bggVeriler = [];
let allRawData = []; // Tüm ham veri (filtrelenmemiş)
let selectedReportMonth = null; // Seçilen rapor tarihi {year, month}

// Excel yükleme
let uploadedFiles = [];
let isUsingCustomData = false;

// Wizard state
let currentStep = 'customize'; // Skip 'data' step - go directly to 'customize'

// ==================== TARİH FİLTRELEME ==================== //

// Verileri seçilen rapora göre filtrele
// Mantık:
// - SEÇİLEN YIL için: Sadece seçilen ayın verisini al
// - GEÇMİŞ YILLAR için: Sadece Aralık ayının verisini al
// - GELECEK AY/YIL: Dahil etme
function filterDataByReportMonth() {
    if (!selectedReportMonth || allRawData.length === 0) return;

    const targetYear = selectedReportMonth.year;
    const targetMonth = selectedReportMonth.month; // 0-indexed (0=Ocak, 11=Aralık)

    console.log(`Filtreleme: ${targetYear} yılı ${targetMonth + 1}. ay seçildi`);

    bggVeriler = allRawData.filter(r => {
        // Sadece BGG (yıllık) verileri al
        if (r.veriAraligi !== 'BGG') return false;

        const sonTarih = parseSonTarih(r.sonTarih);
        if (!sonTarih) return false;

        const dataYear = sonTarih.getFullYear();
        const dataMonth = sonTarih.getMonth();

        // SEÇİLEN YIL: Sadece seçilen ayın verisini al
        if (dataYear === targetYear) {
            return dataMonth === targetMonth;
        }

        // GEÇMİŞ YILLAR: Sadece Aralık (12. ay) verilerini al
        if (dataYear < targetYear) {
            return dataMonth === 11; // 11 = Aralık
        }

        // GELECEK YIL: Dahil etme
        return false;
    });

    console.log(`Filtrelenen BGG veri sayısı: ${bggVeriler.length}`);

    // Debug: yıl bazlı dağılım
    const yearCounts = {};
    bggVeriler.forEach(r => {
        const d = parseSonTarih(r.sonTarih);
        if (d) {
            const y = d.getFullYear();
            yearCounts[y] = (yearCounts[y] || 0) + 1;
        }
    });
    console.log('Yıl bazlı veri dağılımı:', yearCounts);
}

// Son tarih alanını parse et
function parseSonTarih(dateInput) {
    if (!dateInput) return null;

    // Date object
    if (dateInput instanceof Date) {
        return isNaN(dateInput) ? null : dateInput;
    }

    // Excel serial number
    if (typeof dateInput === 'number' && dateInput > 25569 && dateInput < 100000) {
        return new Date(Math.round((dateInput - 25569) * 86400 * 1000));
    }

    // String format (dd.mm.yyyy or ISO)
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

    // Tüm step'leri gizle
    document.querySelectorAll('.wizard-step').forEach(step => {
        step.classList.remove('active');
    });

    // Wizard ve gallery container'ları kontrol et
    const wizardContainer = document.getElementById('wizard-container');
    const galleryContainer = document.getElementById('gallery-container');

    if (stepName === 'gallery') {
        wizardContainer.style.display = 'none';
        galleryContainer.style.display = 'block';
        renderGallery();
    } else {
        wizardContainer.style.display = 'flex';
        galleryContainer.style.display = 'none';

        // İlgili step'i göster
        const stepElement = document.getElementById(`step-${stepName}`);
        if (stepElement) {
            stepElement.classList.add('active');
        }
    }
}

function goToGallery() {
    saveConfig();
    showStep('gallery');
}

// ==================== EXCEL YÜKLEME ==================== //

// Excel dosyasını parse et
async function parseExcelFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const buf = e.target.result;
                const wb = XLSX.read(buf, { type: 'array', cellDates: true });

                const result = { hizmetler: [], aciklamalar: {}, merkezler: [] };

                // Hizmetler sayfası
                const hizSheet = wb.Sheets['Hizmetler'];
                if (hizSheet) {
                    const rows = XLSX.utils.sheet_to_json(hizSheet, { cellDates: true });
                    result.hizmetler = rows.map(r => ({
                        mudurluk: (r['Müdürlük'] || '').toString().trim(),
                        hizmet: (r['Hizmet Başlığı'] || '').toString().trim(),
                        tur: (r['Tür'] || '').toString().trim(),
                        lokasyon: (r['Lokasyon'] || '').toString().trim(),
                        veriAraligi: (r['Veri Aralığı'] || '').toString().trim().toLocaleUpperCase('tr-TR'),
                        deger: parseFloat(r['Değer']) || 0,
                        sonTarih: r['Son Tarih']
                    })).filter(r => r.mudurluk && r.hizmet);
                }

                // Açıklamalar sayfası
                const ackSheet = wb.Sheets['Açıklamalar'];
                if (ackSheet) {
                    const rows = XLSX.utils.sheet_to_json(ackSheet);
                    rows.forEach(r => {
                        const key = r['Hizmet Başlığı'] || r['Hizmet'];
                        const val = r['Açıklama'];
                        if (key && val) result.aciklamalar[key.toString().trim()] = val.toString().trim();
                    });
                }

                // Merkezler sayfası
                const merSheet = wb.Sheets['Merkezler'];
                if (merSheet) {
                    const rows = XLSX.utils.sheet_to_json(merSheet);
                    result.merkezler = rows.map(r => {
                        const koordinatStr = (r['KOORDİNATLAR'] || '').toString();
                        const parts = koordinatStr.split(',').map(s => parseFloat(s.trim()));
                        return {
                            mudurluk: (r['Müdürlük'] || '').toString().trim(),
                            ilce: (r['ILCE'] || r['İlçe'] || r['İLÇE'] || r['ilce'] || '').toString().trim(),
                            tur: (r['Birim Türü'] || r['Tür'] || '').toString().trim(),
                            ad: (r['Birim Adı'] || r['Merkez Adı'] || '').toString().trim(),
                            adres: (r['Adres'] || r['ADRES'] || '').toString().trim(),
                            lat: isNaN(parts[0]) ? null : parts[0],
                            lon: isNaN(parts[1]) ? null : parts[1]
                        };
                    }).filter(m => m.mudurluk && m.ad);
                }

                console.log('📁 Dosya parse edildi:', file.name);
                console.log('   - Sayfa adları:', wb.SheetNames);
                console.log('   - Hizmetler:', result.hizmetler.length);
                console.log('   - Merkezler:', result.merkezler.length);
                console.log('   - Açıklamalar:', Object.keys(result.aciklamalar).length);

                resolve(result);
            } catch (err) {
                console.error('❌ Parse hatası:', err);
                reject(err);
            }
        };
        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
    });
}

// Birden fazla Excel'i birleştir
async function mergeAndLoadExcelData() {
    if (uploadedFiles.length === 0) {
        // Varsayılan veriye dön
        isUsingCustomData = false;
        await loadExcelData();
        return;
    }

    const mergedData = { hizmetler: [], aciklamalar: {}, merkezler: [] };

    for (const file of uploadedFiles) {
        try {
            const data = await parseExcelFile(file);
            mergedData.hizmetler = [...mergedData.hizmetler, ...data.hizmetler];
            mergedData.aciklamalar = { ...mergedData.aciklamalar, ...data.aciklamalar };
            mergedData.merkezler = [...mergedData.merkezler, ...data.merkezler];
        } catch (err) {
            console.error('Dosya parse hatası:', file.name, err);
        }
    }

    // Duplicate temizliği (merkezler için)
    const uniqueMerkezler = [];
    const seenMerkezler = new Set();
    mergedData.merkezler.forEach(m => {
        const key = `${m.mudurluk}-${m.ad}`;
        if (!seenMerkezler.has(key)) {
            seenMerkezler.add(key);
            uniqueMerkezler.push(m);
        }
    });
    mergedData.merkezler = uniqueMerkezler;

    // Global verileri güncelle
    bggVeriler = mergedData.hizmetler.filter(r => r.veriAraligi === 'BGG');

    // Lokasyonları çıkar
    const lokasyonSet = new Set();
    mergedData.hizmetler.forEach(r => {
        if (r.lokasyon && r.lokasyon !== 'Diğer') lokasyonSet.add(r.lokasyon);
    });
    allLocations = Array.from(lokasyonSet).sort((a, b) => {
        if (a === 'İstanbul Geneli') return -1;
        if (b === 'İstanbul Geneli') return 1;
        return a.localeCompare(b, 'tr');
    });

    // Müdürlükleri çıkar
    const mudurlukSet = new Set();
    mergedData.hizmetler.forEach(r => {
        if (r.mudurluk) mudurlukSet.add(r.mudurluk);
    });
    allMudurlukler = Array.from(mudurlukSet).sort((a, b) => a.localeCompare(b, 'tr'));

    // Hizmetleri çıkar
    const hizmetMap = {};
    mergedData.hizmetler.forEach(r => {
        if (!hizmetMap[r.hizmet]) hizmetMap[r.hizmet] = r.mudurluk;
    });
    serviceMudurlukMap = hizmetMap;
    allServices = Object.keys(hizmetMap).sort((a, b) => a.localeCompare(b, 'tr'));

    // Türleri çıkar
    const turSet = new Set();
    mergedData.hizmetler.forEach(r => {
        if (r.tur) turSet.add(r.tur);
    });
    allTurler = Array.from(turSet).sort((a, b) => a.localeCompare(b, 'tr'));

    isUsingCustomData = true;

    // localStorage'a kaydet - viewer sayfası bu veriyi kullanacak (sessionStorage sekmeler arası paylaşılmaz!)
    const dataToStore = {
        hizmetler: mergedData.hizmetler,
        aciklamalar: mergedData.aciklamalar,
        merkezler: mergedData.merkezler,
        timestamp: Date.now()
    };
    localStorage.setItem('customExcelData', JSON.stringify(dataToStore));

    console.log('✅ Özel veri işlendi ve sessionStorage\'a kaydedildi:');
    console.log('   - Toplam hizmet satırı:', mergedData.hizmetler.length);
    console.log('   - BGG verisi:', bggVeriler.length);
    console.log('   - Lokasyonlar:', allLocations.length, allLocations);
    console.log('   - Müdürlükler:', allMudurlukler.length);
    console.log('   - Hizmetler:', allServices.length);
    console.log('   - Türler:', allTurler.length);
    console.log('   - sessionStorage boyutu:', JSON.stringify(dataToStore).length, 'karakter');
}

// Veriden son tarihi al
function getDataDateLabel() {
    let latestDate = null;
    bggVeriler.forEach(r => {
        if (r.sonTarih && r.sonTarih instanceof Date && !isNaN(r.sonTarih)) {
            if (!latestDate || r.sonTarih > latestDate) {
                latestDate = r.sonTarih;
            }
        }
    });

    if (latestDate) {
        const aylar = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
            'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
        return `${aylar[latestDate.getMonth()]} ${latestDate.getFullYear()}`;
    }
    return null;
}



async function loadExcelData() {
    try {
        let data = [];

        // Önce sessionStorage'dan geçici veri kontrolü (aynı sekme)
        let tempRawData = sessionStorage.getItem('temp_strateji_rawdata');
        // Yoksa localStorage'dan kontrol (sekmeler arası paylaşım)
        if (!tempRawData) {
            tempRawData = localStorage.getItem('temp_hizmet_rawdata');
        }

        if (tempRawData) {
            // Geçici veri varsa onu kullan
            console.log('✅ Geçici veri bulundu...');
            const parsed = JSON.parse(tempRawData);
            data = parsed.map(r => ({
                mudurluk: (r.mudurluk || '').toString().trim(),
                hizmet: (r.hizmet || '').toString().trim(),
                tur: (r.tur || '').toString().trim(),
                lokasyon: (r.lokasyon || 'İstanbul Geneli').toString().trim(),
                veriAraligi: (r.veriAraligi || 'BGG').toString().trim().toLocaleUpperCase('tr-TR'),
                deger: parseFloat(r.deger) || 0,
                sonTarih: r.tarih ? new Date(r.tarih) : null
            })).filter(r => r.mudurluk && r.hizmet);
            console.log('Geçici veri yüklendi:', data.length, 'kayıt');
        } else {
            // Varsayılan: veri.xlsx'ten yükle
            const res = await fetch('hizmet-verileri/veri.xlsx');
            const buf = await res.arrayBuffer();
            const wb = XLSX.read(buf, { type: 'array', cellDates: true });

            // Hizmetler sayfası
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

        // Process data (from either source)
        if (data.length > 0) {
            // Ham veriyi kaydet (filtreleme sonra yapılacak)
            allRawData = data;

            // Lokasyonları çıkar
            const lokasyonSet = new Set();
            data.forEach(r => {
                if (r.lokasyon && r.lokasyon !== 'Diğer') {
                    lokasyonSet.add(r.lokasyon);
                }
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

            // Hizmetleri ve müdürlük ilişkisini çıkar
            const hizmetMap = {};
            data.forEach(r => {
                if (!hizmetMap[r.hizmet]) {
                    hizmetMap[r.hizmet] = r.mudurluk;
                }
            });
            serviceMudurlukMap = hizmetMap;
            allServices = Object.keys(hizmetMap).sort((a, b) => a.localeCompare(b, 'tr'));

            // Tüm türleri çıkar (unique)
            const turSet = new Set();
            data.forEach(r => {
                if (r.tur) turSet.add(r.tur);
            });
            allTurler = Array.from(turSet).sort((a, b) => a.localeCompare(b, 'tr'));

            console.log('Veriler yüklendi:', {
                bgg: bggVeriler.length,
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

// ==================== CONFIG YÖNETİMİ ==================== //

function getDefaultConfig() {
    const config = {
        services: {},
        turler: {}
    };

    // Tüm hizmetler default açık
    allServices.forEach(hizmet => {
        config.services[hizmet] = true;
    });

    // Tüm türler default açık
    allTurler.forEach(tur => {
        config.turler[tur] = true;
    });

    return config;
}

let serviceConfig = {};

function loadConfig() {
    try {
        const saved = localStorage.getItem('serviceConfig');
        if (saved) {
            serviceConfig = JSON.parse(saved);
            // Yeni türler/hizmetler eklenmişse config'e ekle
            allServices.forEach(h => {
                if (!(h in serviceConfig.services)) serviceConfig.services[h] = true;
            });
            allTurler.forEach(t => {
                if (!(t in serviceConfig.turler)) serviceConfig.turler[t] = true;
            });
        } else {
            serviceConfig = getDefaultConfig();
        }
    } catch (e) {
        serviceConfig = getDefaultConfig();
    }
}

function saveConfig() {
    localStorage.setItem('serviceConfig', JSON.stringify(serviceConfig));
}

function resetConfig() {
    serviceConfig = getDefaultConfig();
    saveConfig();
}

// ==================== UI RENDER ==================== //

function renderTurList() {
    const container = document.getElementById('tur-list');

    if (allTurler.length === 0) {
        container.innerHTML = '<div style="text-align: center; padding: 1rem; color: var(--gray-400);">Tür bulunamadı</div>';
        return;
    }

    let html = '';
    allTurler.forEach((tur, index) => {
        const isChecked = serviceConfig.turler[tur] !== false;

        html += `
            <div class="selection-item ${isChecked ? 'checked' : ''}" 
                 onclick="toggleTurPill('${tur.replace(/'/g, "\\'")}', ${index})">
                <label>${tur}</label>
            </div>
        `;
    });

    container.innerHTML = html;
}

function renderServiceList() {
    const container = document.getElementById('service-list');

    if (allServices.length === 0) {
        container.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--gray-400);">Hizmet bulunamadı</div>';
        return;
    }

    // Müdürlüklere göre grupla
    const mudurlukGroups = {};
    allMudurlukler.forEach(mud => {
        mudurlukGroups[mud] = allServices.filter(h => serviceMudurlukMap[h] === mud);
    });

    let html = '';
    allMudurlukler.forEach((mudurluk, mudIndex) => {
        const hizmetler = mudurlukGroups[mudurluk];
        if (hizmetler.length === 0) return;

        html += `
            <div class="group-item" id="mudurluk-${mudIndex}">
                <div class="group-header" onclick="toggleMudurlukExpand(${mudIndex})">
                    <span class="group-name">${mudurluk}</span>
                    <span class="group-count">${hizmetler.length} hizmet</span>
                    <button class="group-expand">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="9 18 15 12 9 6"></polyline>
                        </svg>
                    </button>
                </div>
                <div class="group-content">
                    ${hizmetler.map((hizmet, hIndex) => {
            const isChecked = serviceConfig.services[hizmet] !== false;
            return `
                            <div class="selection-item list-style">
                                <input type="checkbox" 
                                       id="service-${mudIndex}-${hIndex}" 
                                       ${isChecked ? 'checked' : ''}
                                       onchange="toggleService('${hizmet.replace(/'/g, "\\'")}', this.checked)">
                                <label for="service-${mudIndex}-${hIndex}">${hizmet}</label>
                            </div>
                        `;
        }).join('')}
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
}

function renderGallery() {
    const container = document.getElementById('report-gallery');

    // Aktif hizmetler ve türler
    const activeServices = allServices.filter(h => serviceConfig.services[h] !== false);
    const activeTurler = allTurler.filter(t => serviceConfig.turler[t] !== false);

    // Stats güncelle
    const statsEl = document.getElementById('gallery-stats');
    statsEl.textContent = `${allLocations.length} lokasyon, ${activeServices.length} hizmet, ${activeTurler.length} tür`;

    // Kartları oluştur
    let html = '';
    allLocations.forEach(location => {
        // Bu lokasyon için kaç hizmet var?
        const serviceCount = activeServices.filter(hizmet => {
            return bggVeriler.some(v =>
                v.lokasyon === location &&
                v.hizmet === hizmet &&
                activeTurler.includes(v.tur)
            );
        }).length;

        // URL encode ile location parametresi
        const encodedLocation = encodeURIComponent(location);
        const reportMonthInput = document.getElementById('report-month');
        const reportMonthVal = reportMonthInput ? reportMonthInput.value : '';
        const viewUrl = `viewer.html?location=${encodedLocation}${reportMonthVal ? '&reportMonth=' + reportMonthVal : ''}`;

        html += `
            <div class="report-card">
                <div>
                    <h3 class="card-title">${location}</h3>
                </div>
                <div class="card-actions">
                    <a href="${viewUrl}" target="_blank" class="btn-view">
                        Görüntüle
                    </a>
                    <a href="${viewUrl}&autoprint=1" target="_blank" class="btn-download">
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

// ==================== EVENT HANDLERS ==================== //

window.toggleTur = function (tur, enabled) {
    serviceConfig.turler[tur] = enabled;
};

window.toggleTurPill = function (tur, index) {
    const current = serviceConfig.turler[tur] !== false;
    serviceConfig.turler[tur] = !current;
    renderTurList();
};

window.toggleService = function (hizmet, enabled) {
    serviceConfig.services[hizmet] = enabled;
};

window.toggleMudurlukExpand = function (index) {
    const group = document.getElementById(`mudurluk-${index}`);
    group.classList.toggle('expanded');
};

// ==================== INIT ==================== //

async function init() {
    // Varsayılan verileri yükle
    const success = await loadExcelData();

    if (!success) {
        alert('Veriler yüklenemedi. Lütfen sayfayı yenileyin.');
        return;
    }

    // Config'i varsayılana sıfırla - tüm hizmetler ve türler görünsün
    resetConfig();

    // Rapor tarihi başlat (varsayılan: önceki ay)
    const reportMonthInput = document.getElementById('report-month');
    if (reportMonthInput) {
        const now = new Date();
        now.setMonth(now.getMonth() - 1);
        const defaultMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        reportMonthInput.value = defaultMonth;

        selectedReportMonth = { year: now.getFullYear(), month: now.getMonth() };
        filterDataByReportMonth();

        // Ay değiştiğinde yeniden filtrele
        reportMonthInput.addEventListener('change', (e) => {
            const [y, m] = e.target.value.split('-');
            selectedReportMonth = { year: parseInt(y), month: parseInt(m) - 1 };
            filterDataByReportMonth();
        });
    }


    // ATLAMA: Doğrudan 'customize' step'ine git (veri kaynağı seçimi index.html'den yapılıyor)
    showStep('customize');
    renderTurList();
    renderServiceList();

    // ==================== TÜR/HİZMET SEÇİMİ ==================== //

    // Tümünü Seç - Türler
    document.getElementById('btn-select-all-turler').addEventListener('click', () => {
        const allChecked = allTurler.every(t => serviceConfig.turler[t] !== false);
        allTurler.forEach(t => {
            serviceConfig.turler[t] = !allChecked;
        });
        renderTurList();
    });

    // Tümünü Seç - Hizmetler
    document.getElementById('btn-select-all-services').addEventListener('click', () => {
        const allChecked = allServices.every(s => serviceConfig.services[s] !== false);
        allServices.forEach(s => {
            serviceConfig.services[s] = !allChecked;
        });
        renderServiceList();
    });

    // Raporları oluştur
    document.getElementById('btn-create-reports').addEventListener('click', () => {
        goToGallery();
    });

    // Service search
    document.getElementById('service-search').addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        const groups = document.querySelectorAll('.group-item');
        groups.forEach(group => {
            const items = group.querySelectorAll('.selection-item');
            let hasVisible = false;
            items.forEach(item => {
                const label = item.querySelector('label').textContent.toLowerCase();
                const matches = label.includes(query);
                item.style.display = matches ? '' : 'none';
                if (matches) hasVisible = true;
            });
            // Müdürlük grubunu gizle/göster
            group.style.display = hasVisible || query === '' ? '' : 'none';
        });
    });

    // ==================== GALERİ ==================== //

    // Ayarları değiştir butonu - wizard'a geri dön
    document.getElementById('btn-back-to-wizard').addEventListener('click', () => {
        showStep('customize');
    });

    console.log('Galeri başlatıldı');
}

init();
