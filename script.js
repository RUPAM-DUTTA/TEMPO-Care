// --- Database Client Configuration ---
const SUPABASE_URL = "https://sgfbyszvsfebzcxxjlvc.supabase.co";
const SUPABASE_KEY = "sb_publishable_n0V0owGDLWp9W4ZtUOWyag_M3RQ7e10";
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// --- GLOBAL APP STATE (Data Isolation Tracker) ---
const appState = {
    activeProfileId: null,
    allowedProfileIds: []
};

// --- Database Operations (Layer with End-to-End Isolation) ---
const appDatabase = {
    // Users
    saveUser: async function(user) {
        const { data, error } = await supabaseClient.from('tempo_users').insert([user]).select();
        if (error) console.error("Save User Error:", error.message);
        return { data, error };
    },
    getUser: async function(phone, role) {
        const { data, error } = await supabaseClient.from('tempo_users').select('*').eq('phone', phone).eq('role', role);
        if (error) console.error("Get User Error:", error.message);
        return data || [];
    },
    
    // Deletes user and explicitly cascades deletes to all profiles, health profiles, activity logs, and alerts associated with this user.
    deleteUserAndData: async function(phone, role) {
        try {
            // 1. Fetch all profiles where this phone is a family member
            const { data: profiles, error: profileErr } = await supabaseClient.from('tempo_profiles').select('*');
            if (profileErr) { console.error("Error fetching profiles for deletion:", profileErr.message); return; }
            
            const linkedProfiles = profiles.filter(p => p.family_members && p.family_members.some(f => f.phone === phone));
            const linkedProfileIds = linkedProfiles.map(p => p.id);

            // 2. Cascade delete all linked data tied to these Care Focus profiles
            for (let pid of linkedProfileIds) {
                // Delete Health Profiles
                await supabaseClient.from('tempo_health_profiles').delete().eq('profile_id', pid);
                // Delete Activity Logs
                await supabaseClient.from('tempo_activity_log').delete().eq('profile_id', pid);
                // Delete Care Focus Profile itself
                await supabaseClient.from('tempo_profiles').delete().eq('id', pid);
            }

            // 3. Delete Alerts sent specifically to this user
            await supabaseClient.from('tempo_alerts').delete().eq('recipient_phone', phone);

            // 4. Delete the User's actual account
            const { error: userErr } = await supabaseClient.from('tempo_users').delete().eq('phone', phone).eq('role', role);
            if (userErr) console.error("Delete User Error:", userErr.message);
            
        } catch (err) {
            console.error("Error in cascaded delete operation:", err);
        }
    },

    // Care Focus Profiles
    saveProfile: async function(profile) {
        const { data, error } = await supabaseClient.from('tempo_profiles').insert([{
            id: profile.id,
            name: profile.name,
            age: parseInt(profile.age),
            gender: profile.gender,
            phone: profile.phone,
            emergency: profile.emergency,
            photo_data: profile.photoData,
            family_members: profile.familyMembers
        }]).select();
        if (error) console.error("Save Profile Error:", error.message);
        return { data, error };
    },
    getProfiles: async function() {
        const { data, error } = await supabaseClient.from('tempo_profiles').select('*').order('created_at', { ascending: false });
        if (error) { console.error("Fetch Profiles Error:", error.message); return []; }
        
        // Data Isolation logic: Admin sees all, User sees only their linked profiles
        if (appAuth.currentSelectedRole === 'Admin') return data;
        return data.filter(p => p.family_members && p.family_members.some(f => f.phone === appAuth.currentUserPhone));
    },
    deleteProfile: async function(id) {
        const { error } = await supabaseClient.from('tempo_profiles').delete().eq('id', id);
        if (error) console.error("Delete Profile Error:", error.message);
    },

    // Health Profiles
    saveHealthProfile: async function(healthData) {
        const { data, error } = await supabaseClient.from('tempo_health_profiles').insert([healthData]).select();
        if (error) console.error("Save Health Profile Error:", error.message);
        return { data, error };
    },
    getHealthProfiles: async function() {
        const { data, error } = await supabaseClient.from('tempo_health_profiles').select('*').order('created_at', { ascending: false });
        if (error) { console.error("Fetch Health Profiles Error:", error.message); return []; }

        // Data Isolation
        if (appAuth.currentSelectedRole === 'Admin') return data;
        return data.filter(h => appState.allowedProfileIds.includes(h.profile_id));
    },

    // Activity Logs
    logActivity: async function(activity, profileId) {
        if (!profileId && appAuth.currentSelectedRole !== 'Admin') return; // Cannot map activity if no active profile
        const entry = { id: Date.now(), activity: activity, profile_id: profileId };
        const { error } = await supabaseClient.from('tempo_activity_log').insert([entry]);
        if (error) console.error("Log Activity Error:", error.message);
        renderTimeline();
    },
    getActivityLogs: async function(limit = 35) {
        const { data, error } = await supabaseClient.from('tempo_activity_log').select('*').order('created_at', { ascending: false }).limit(limit);
        if (error) { console.error("Fetch Activity Logs Error:", error.message); return []; }
        
        // Data Isolation
        if (appAuth.currentSelectedRole === 'Admin') return data;
        return data.filter(a => appState.allowedProfileIds.includes(a.profile_id));
    },

    // Alerts
    saveAlert: async function(alertData) {
        const { error } = await supabaseClient.from('tempo_alerts').insert([alertData]);
        if (error) console.error("Save Alert Error:", error.message);
    },
    getAlerts: async function() {
        const { data, error } = await supabaseClient.from('tempo_alerts').select('*').order('created_at', { ascending: false });
        if (error) { console.error("Fetch Alerts Error:", error.message); return []; }

        // Data Isolation by mapped recipient phone
        if (appAuth.currentSelectedRole === 'Admin') return data;
        return data.filter(a => a.recipient_phone === appAuth.currentUserPhone);
    }
};

// --- App State Initializer ---
async function refreshAppState() {
    const profiles = await appDatabase.getProfiles();
    appState.allowedProfileIds = profiles.map(p => p.id);
    if (profiles.length > 0) {
        appState.activeProfileId = profiles[0].id;
    }
}

// --- Sidebar & App Navigation Logic ---
const menuToggleBtn = document.getElementById('menuToggleBtn');
const sidebarMenu = document.getElementById('sidebarMenu');
const sidebarOverlay = document.getElementById('sidebarOverlay');
const closeSidebarBtn = document.getElementById('closeSidebar');

function toggleSidebar() {
    sidebarMenu.classList.toggle('open');
    sidebarOverlay.classList.toggle('active');
}

menuToggleBtn.addEventListener('click', toggleSidebar);
closeSidebarBtn.addEventListener('click', toggleSidebar);
sidebarOverlay.addEventListener('click', toggleSidebar);

const appNav = {
    hideAllSections: function() {
        document.querySelectorAll('.view-section').forEach(s => s.style.display = 'none');
        document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));
    },

    goToHome: function() {
        this.hideAllSections();
        document.getElementById('topNav').style.display = 'flex';
        document.getElementById('bottomNav').style.display = 'flex';
        document.getElementById('viewDashboard').style.display = 'block';
        document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));
        document.querySelector('.nav-item[data-target="viewDashboard"]').classList.add('active');
        // first time on the dashboard after login: reconnect to the paired device
        if (typeof linkUI !== 'undefined' && !linkUI._auto) { linkUI._auto = true; linkUI.autoConnect(); }
    },

    startOnboarding: function() {
        this.hideAllSections();
        document.getElementById('topNav').style.display = 'none';
        document.getElementById('bottomNav').style.display = 'none';
        document.getElementById('viewWizardForms').style.display = 'block';
        onboardingWizard.reset();
        photoHandler.reset();
    },

    cancelOnboarding: async function() {
        const profiles = await appDatabase.getProfiles();
        if (profiles.length === 0) {
            appAuth.logout();
            document.getElementById('tabLogin').click();
        } else {
            this.goToHome();
        }
    },

    openAdminDashboard: function() {
        if(sidebarMenu.classList.contains('open')) toggleSidebar();
        this.hideAllSections();
        document.getElementById('viewAdminDashboard').style.display = 'block';
        this.renderAdminDashboardContent();
    },

    openDoctorReport: function() {
        if(sidebarMenu.classList.contains('open')) toggleSidebar();
        this.hideAllSections();
        document.getElementById('viewDoctorReport').style.display = 'block';
    },

    openAlerts: function() {
        if(sidebarMenu.classList.contains('open')) toggleSidebar();
        this.hideAllSections();
        document.getElementById('viewAlerts').style.display = 'block';
        appAlerts.renderAlerts();
    },

    openSettings: function() {
        if(sidebarMenu.classList.contains('open')) toggleSidebar();
        this.hideAllSections();
        document.getElementById('viewSettings').style.display = 'block';

        // Toggle Admin DB Access Icon visibility
        if (appAuth.currentSelectedRole === 'Admin') {
            document.getElementById('adminDbAccess').style.display = 'flex';
        } else {
            document.getElementById('adminDbAccess').style.display = 'none';
        }
    },

    deleteProfile: async function(id) {
        if (confirm("Are you sure you want to delete this profile from the database?")) {
            await appDatabase.deleteProfile(id);
            await refreshAppState();
            if (document.getElementById('viewAdminDashboard').style.display === 'block') {
                this.renderAdminDashboardContent();
            } else if (document.getElementById('viewProfile').style.display === 'block') {
                loadProfiles();
            }
        }
    },

    renderAdminDashboardContent: async function() {
        const container = document.getElementById('adminDashboardContent');
        container.innerHTML = "<p class='text-muted'>Loading records from Database...</p>";
        const profiles = await appDatabase.getProfiles();

        if(profiles.length === 0) {
            container.innerHTML = "<div class='card glass-panel'><p class='text-muted'>No registered profiles in the database yet.</p></div>";
            return;
        }

        container.innerHTML = profiles.map(p => `
            <div class="card glass-panel pop-in" style="border-left: 4px solid var(--accent-blue); position: relative;">
                <button class="del-btn hover-scale" style="position: absolute; top: 15px; right: 15px;" onclick="appNav.deleteProfile(${p.id})">
                    <i class="fa-solid fa-trash"></i>
                </button>
                <div style="display: flex; align-items: center; gap: 15px; margin-bottom: 15px; padding-right: 40px;">
                    <div class="icon-circle glow-blue" style="width: 55px; height: 55px; font-size: 1.6rem; overflow: hidden; padding: 0; border: 2px solid rgba(255,255,255,0.1);">
                        ${p.photo_data ? `<img src="${p.photo_data}" style="width: 100%; height: 100%; object-fit: cover;">` : `<i class="fa-solid fa-user"></i>`}
                    </div>
                    <div>
                        <h3 style="margin: 0; font-size: 1.2rem; font-weight: 800;" class="text-gradient-blue-purple">${p.name}</h3>
                        <p style="margin: 0; color: var(--text-muted); font-size: 0.95rem;">Age: ${p.age} | ${p.gender}</p>
                    </div>
                </div>
                <div class="form-row" style="padding: 8px 0; border: none; margin: 0;">
                    <span class="text-muted"><i class="fa-solid fa-phone text-blue"></i> Phone</span>
                    <span class="text-main font-weight: 600;">${p.phone || 'N/A'}</span>
                </div>
                <div class="form-row" style="padding: 8px 0; border: none; margin: 0;">
                    <span class="text-muted"><i class="fa-solid fa-truck-medical text-red"></i> Emergency</span>
                    <span class="text-red" style="font-weight: 700;">${p.emergency}</span>
                </div>

                <h4 style="margin: 20px 0 10px 0; color: var(--text-muted); font-size: 0.9rem; text-transform: uppercase; letter-spacing: 1px;">Care Family (${p.family_members ? p.family_members.length : 0})</h4>
                ${p.family_members && p.family_members.length > 0 ? p.family_members.map(f => `
                    <div class="family-member-item hover-scale-subtle">
                        <div>
                            <strong class="text-main">${f.name}</strong> <span class="text-cyan" style="font-size: 0.8rem; background: rgba(6,182,212,0.1); padding: 2px 6px; border-radius: 4px; margin-left: 5px;">${f.relation}</span>
                        </div>
                        <span style="color: var(--accent-purple); font-size: 0.95rem; font-weight: 600;">${f.phone}</span>
                    </div>
                `).join('') : '<p class="text-muted" style="font-size: 0.9rem; font-style: italic;">None added.</p>'}
            </div>
        `).join('');
    }
};

// --- Photo Upload Handler ---
const photoHandler = {
    hasPermission: false,
    base64Data: null,

    requestPermission: function() {
        if (this.hasPermission) {
            document.getElementById('cfPhotoInput').click();
        } else {
            document.getElementById('permissionOverlay').classList.add('active');
        }
    },
    denyPermission: function() {
        document.getElementById('permissionOverlay').classList.remove('active');
        alert("Permission denied.");
    },
    grantPermission: function() {
        this.hasPermission = true;
        document.getElementById('permissionOverlay').classList.remove('active');
        document.getElementById('cfPhotoInput').click();
    },
    handleFile: function(event) {
        const file = event.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (e) => {
                this.base64Data = e.target.result;
                const preview = document.getElementById('cfPhotoPreview');
                preview.src = this.base64Data;
                preview.style.display = 'block';
                document.getElementById('cfPhotoIcon').style.display = 'none';
                document.getElementById('cfPhotoEditOverlay').classList.add('active');
                document.getElementById('cfPhotoText').innerText = 'Change Photo';
                document.getElementById('cfPhotoDeleteBtn').style.display = 'flex';
            };
            reader.readAsDataURL(file);
        }
    },
    removePhoto: function() {
        this.base64Data = null;
        document.getElementById('cfPhotoInput').value = '';
        const preview = document.getElementById('cfPhotoPreview');
        preview.style.display = 'none';
        preview.src = '';
        document.getElementById('cfPhotoIcon').style.display = 'block';
        document.getElementById('cfPhotoEditOverlay').classList.remove('active');
        document.getElementById('cfPhotoText').innerText = 'Add Photo';
        document.getElementById('cfPhotoDeleteBtn').style.display = 'none';
    },
    reset: function() {
        this.removePhoto();
    }
};

// --- Alerts and SMS Simulation ---
const appAlerts = {
    triggerSimulatedAlert: async function() {
        const messages = [
            "Prolonged inactivity detected in the bathroom.",
            "Abnormal Stand-to-Sit pattern identified (Possible Fall).",
            "Unusual exit activity during nighttime hours."
        ];
        const randomMessage = messages[Math.floor(Math.random() * messages.length)];
        const notifyPhone = appAuth.currentUserPhone || "+1 (555) 000-0000";

        const newAlert = {
            id: Date.now(),
            message: randomMessage,
            recipient_phone: notifyPhone
        };
        await appDatabase.saveAlert(newAlert);

        alert(`🚨 AUTOMATIC ALERT SMS DISPATCHED 🚨\n\nSent to: ${notifyPhone}\nMessage: "TEMPO Care Alert - ${randomMessage}"`);
        this.renderAlerts();
    },

    renderAlerts: async function() {
        const alerts = await appDatabase.getAlerts();
        const container = document.getElementById('alertsContainer');

        if(alerts.length === 0) {
            container.innerHTML = "<p class='text-muted' style='text-align:center; padding: 20px 0;'>No unusual activity detected.</p>";
            return;
        }

        container.innerHTML = alerts.map(a => `
            <div class="alert-item pop-in">
                <div class="alert-icon"><i class="fa-solid fa-triangle-exclamation"></i></div>
                <div style="flex:1;">
                    <strong style="color: #f8fafc; font-size: 1.05rem;">${a.message}</strong><br>
                    <small class="text-muted">${new Date(a.created_at).toLocaleString()}</small>
                </div>
                <span class="sms-badge"><i class="fa-solid fa-check-double"></i> SMS Sent</span>
            </div>
        `).join('');
    }
};

// --- Wizard Form: Care Focus Profiles ---
const onboardingWizard = {
    tempFamily: [],
    tempFocuses: [],
    currentFocusId: null,

    addCareFocus: function(isFinal = false) {
        const name = document.getElementById('cfName').value.trim();
        
        if(!name && !isFinal) return;
        if(!name) { alert("Please provide the full name for the Care Focus."); return; }
        
        const focusData = {
            id: Date.now() + Math.floor(Math.random() * 1000),
            name: name,
            age: document.getElementById('cfAge').value,
            gender: document.getElementById('cfGender').value,
            phone: document.getElementById('cfPhone').value,
            emergency: document.getElementById('cfEmergency').value,
            photoData: photoHandler.base64Data,
            familyMembers: this.tempFamily
        };

        this.tempFocuses.push(focusData);
        this.renderFocusList();

        document.getElementById('cfName').value = '';
        document.getElementById('cfAge').value = '';
        document.getElementById('cfGender').value = '';
        document.getElementById('cfPhone').value = '';
        document.getElementById('cfEmergency').value = '';
        photoHandler.reset();
    },
    removeCareFocus: function(index) {
        this.tempFocuses.splice(index, 1);
        this.renderFocusList();
    },
    renderFocusList: function() {
        const container = document.getElementById('addedFocusMembers');
        if(this.tempFocuses.length === 0) {
            container.innerHTML = "";
            return;
        }
        container.innerHTML = this.tempFocuses.map((f, index) => `
            <div class="family-member-item pop-in" style="border-left: 4px solid var(--accent-purple);">
                <div>
                    <strong class="text-main" style="font-size: 1.1rem;">${f.name}</strong> <span class="text-muted">(Age: ${f.age} | ${f.gender})</span><br>
                    <small style="color: var(--accent-red); margin-top: 5px; display: inline-block; font-weight: 600;"><i class="fa-solid fa-truck-medical"></i> ${f.emergency}</small>
                </div>
                <button class="del-btn hover-scale" onclick="onboardingWizard.removeCareFocus(${index})"><i class="fa-solid fa-trash"></i></button>
            </div>
        `).join('');
    },
    
    saveAll: async function() {
        if (document.getElementById('cfName').value.trim() !== '') {
            this.addCareFocus(true);
        }

        if (this.tempFocuses.length === 0) {
            alert("Please register at least one Care Focus (Person to be monitored).");
            return;
        }

        for (let focus of this.tempFocuses) {
            const { error } = await appDatabase.saveProfile(focus);
            if (error) {
                alert("Error saving profile to the database: " + error.message);
                return;
            }
        }

        this.currentFocusId = this.tempFocuses[0].id;

        // Force a state refresh so the new profile is immediately active
        await refreshAppState();

        alert("Profiles successfully saved to the database! Please complete the baseline Health Profile.");
        document.getElementById('wizardStepFocus').style.display = 'none';
        healthWizard.showStep(1);
    },
    reset: function() {
        document.getElementById('cfName').value = '';
        document.getElementById('cfAge').value = '';
        document.getElementById('cfGender').value = '';
        document.getElementById('cfPhone').value = '';
        document.getElementById('cfEmergency').value = '';
        
        this.tempFocuses = [];
        this.currentFocusId = null;
        this.renderFocusList();
        
        document.getElementById('wizardStepFocus').style.display = 'block';
    }
};

// --- Wizard Form: Health Profile ---
const healthWizard = {
    currentStep: 1,
    issueCount: 0,

    showStep: function(step) {
        for(let i = 1; i <= 5; i++) {
            const el = document.getElementById('healthStep' + i);
            if (i === step) {
                el.style.display = 'block';
                // Trigger re-animation
                el.classList.remove('fade-in-up');
                void el.offsetWidth; 
                el.classList.add('fade-in-up');
            } else {
                el.style.display = 'none';
            }
        }
        this.currentStep = step;
        window.scrollTo(0, 0);
    },
    nextStep: function() {
        if(this.currentStep < 5) this.showStep(this.currentStep + 1);
    },
    prevStep: function() {
        if(this.currentStep > 1) {
            this.showStep(this.currentStep - 1);
        } else if (this.currentStep === 1) {
            document.getElementById('healthStep1').style.display = 'none';
            document.getElementById('wizardStepFocus').style.display = 'block';
        }
    },
    addOtherIssue: function() {
        this.issueCount++;
        const container = document.getElementById('additionalIssuesContainer');
        const inputDiv = document.createElement('div');
        inputDiv.style.marginBottom = '12px';
        inputDiv.className = 'pop-in';
        inputDiv.innerHTML = `<input type="text" class="input-field dynamic-other-issue glow-focus" placeholder="Describe issue #${this.issueCount}" style="margin-bottom:0;">`;
        container.appendChild(inputDiv);
    },
    saveProfile: async function() {
        const fracParts = Array.from(document.querySelectorAll('#hpFracParts input:checked')).map(el => el.value);
        const knees = Array.from(document.querySelectorAll('#hpKnees input:checked')).map(el => el.value);
        const otherIssues = Array.from(document.querySelectorAll('.dynamic-other-issue')).map(el => el.value).filter(Boolean);

        const healthData = {
            profile_id: onboardingWizard.currentFocusId,
            has_diabetes: document.getElementById('hpDiabetes').checked,
            hba1c: document.getElementById('hpHba1c').value || null,
            sugar_fasting: document.getElementById('hpSugarFast').value || null,
            sugar_postprandial: document.getElementById('hpSugarPost').value || null,
            takes_diab_med: document.getElementById('hpDiabMed').checked,
            diab_med_name: document.getElementById('hpDiabMedName').value || null,
            diab_med_freq: document.getElementById('hpDiabMedFreq').value,
            has_bp: document.getElementById('hpBP').checked,
            bp_systolic: document.getElementById('hpBPSystolic').value || null,
            bp_diastolic: document.getElementById('hpBPDiastolic').value || null,
            bp_last_check: document.getElementById('hpBPDate').value || null,
            takes_bp_med: document.getElementById('hpBPMed').checked,
            bp_med_name: document.getElementById('hpBPMedName').value || null,
            bp_med_freq: document.getElementById('hpBPMedFreq').value,
            has_fracture: document.getElementById('hpFrac').checked,
            fracture_parts: fracParts,
            has_metal_implant: document.getElementById('hpMetal').checked,
            metal_implant_details: document.getElementById('hpMetalDetails').value || null,
            has_mobility_issue: document.getElementById('hpMob').checked,
            mobility_knees: knees,
            sitting_standing_difficulty: document.getElementById('hpDiffSitStand').checked,
            bathroom_assistance: document.getElementById('hpBathAssist').checked,
            caregiver_present: document.getElementById('hpCaregiver').checked,
            has_sleep_issue: document.getElementById('hpSleepIssues').checked,
            sleep_duration: parseInt(document.getElementById('hpSleepHours').value) || 6,
            night_bathroom_frequency: parseInt(document.getElementById('hpNightVisits').value) || 2,
            has_memory_issue: document.getElementById('hpMemory').checked,
            relevant_notes: document.getElementById('hpNotes').value || null,
            other_issues: otherIssues
        };

        const { error } = await appDatabase.saveHealthProfile(healthData);
        if (error) {
            alert("Warning: Error saving health profile: " + error.message);
        } else {
            alert("Health Profile successfully registered in the database!");
        }
        appNav.goToHome();
    }
};

// --- Authentication Layer ---
const appAuth = {
    currentSelectedRole: 'Admin',
    currentUserPhone: null,
    extraFamilyCount: 0,

    showAuthScreen: function(role) {
        this.currentSelectedRole = role;
        document.getElementById('welcomeScreen').style.display = 'none';
        
        const authScreen = document.getElementById('authScreen');
        authScreen.style.display = 'block';
        
        document.getElementById('authRoleTitle').innerText = role + ' Access';
        
        if (role === 'Admin') {
            document.getElementById('tabSignup').style.display = 'none';
            document.getElementById('tabLogin').click();
            document.getElementById('authTabs').style.justifyContent = 'center'; 
            document.getElementById('loginPhone').placeholder = "Enter Developer Admin ID";
        } else {
            document.getElementById('tabSignup').style.display = 'block';
            document.getElementById('authTabs').style.justifyContent = 'space-between';
            document.getElementById('loginPhone').placeholder = "Mobile Number / Email";
            document.getElementById('tabLogin').click();
        }
    },
    showWelcomeScreen: function() {
        document.getElementById('authScreen').style.display = 'none';
        
        const ws = document.getElementById('welcomeScreen');
        ws.style.display = 'block';
        ws.classList.remove('pop-in');
        void ws.offsetWidth;
        ws.classList.add('pop-in');
    },

    toggleOtherRelation: function(selectElem, targetId) {
        const targetInput = document.getElementById(targetId);
        if(selectElem.value === 'Other') {
            targetInput.style.display = 'block';
            targetInput.classList.add('pop-in');
        } else {
            targetInput.style.display = 'none';
        }
    },

    addAnotherFamilyMember: function() {
        this.extraFamilyCount++;
        const container = document.getElementById('extraFamilyMembers');
        const blockId = 'extraFamBlock_' + this.extraFamilyCount;
        const otherRelId = 'otherRel_' + this.extraFamilyCount;
        
        const html = `
            <div class="extra-fam-block pop-in" id="${blockId}">
                <button class="del-btn hover-scale" style="position:absolute; top: 10px; right: 10px; z-index:10; padding: 5px 8px;" onclick="appAuth.removeFamilyBlock('${blockId}')"><i class="fa-solid fa-times"></i></button>
                <input type="text" class="input-field glow-focus fam-name" placeholder="Additional Family Name *">
                <input type="tel" class="input-field glow-focus fam-phone" placeholder="Mobile Number *">
                
                <select class="input-field glow-focus fam-relation" onchange="appAuth.toggleOtherRelation(this, '${otherRelId}')">
                    <option value="">Relation with Care Focus *</option>
                    <option value="Son">Son</option>
                    <option value="Daughter">Daughter</option>
                    <option value="Spouse">Spouse</option>
                    <option value="Father">Father</option>
                    <option value="Mother">Mother</option>
                    <option value="Other">Other</option>
                </select>
                <input type="text" id="${otherRelId}" class="input-field glow-focus fam-relation-other" placeholder="Specify Relation *" style="display: none; margin-top: -5px; margin-bottom: 15px;">
                
                <input type="email" class="input-field glow-focus fam-email" placeholder="Email (Optional)">
            </div>
        `;
        container.insertAdjacentHTML('beforeend', html);
    },
    removeFamilyBlock: function(blockId) {
        const block = document.getElementById(blockId);
        if (block) block.remove();
    },

    login: async function() {
        const phone = document.getElementById('loginPhone').value.trim();
        const pass = document.getElementById('loginPass').value;

        if (!phone || !pass) {
            alert("Please enter credentials.");
            return;
        }

        if (this.currentSelectedRole === 'Admin') {
            if (phone === 'Rupam' && pass === 'Rupam123') {
                this.currentUserPhone = 'Rupam';
                document.getElementById('authOverlay').classList.remove('active');
                document.getElementById('currentUserDisplay').innerText = "Developer (Admin)";
                document.getElementById('navAdminDashboard').style.display = "flex"; 
                await refreshAppState();
                appNav.goToHome();
            } else {
                alert("Restricted Access: Invalid Developer Credentials.");
            }
            return;
        }

        const users = await appDatabase.getUser(phone, this.currentSelectedRole);
        const user = users.find(u => u.password === pass);

        if (user) { 
            this.currentUserPhone = phone;
            document.getElementById('authOverlay').classList.remove('active');
            document.getElementById('currentUserDisplay').innerText = user.name;
            document.getElementById('navAdminDashboard').style.display = "none"; 

            await refreshAppState();
            const profiles = await appDatabase.getProfiles();

            if (profiles.length === 0) {
                appNav.startOnboarding();
            } else {
                appNav.goToHome();
            }
        } else {
            alert(`No matching ${this.currentSelectedRole} credentials found. Please verify or sign up.`);
        }
    },
    logout: function() {
        if(sidebarMenu.classList.contains('open')) toggleSidebar();
        deviceLink.disconnectAll();
        if (typeof linkUI !== 'undefined') linkUI._auto = false;
        resetLiveTiles();

        this.currentUserPhone = null;
        appState.activeProfileId = null;
        appState.allowedProfileIds = [];

        document.getElementById('currentUserDisplay').innerText = "Live";
        document.getElementById('topNav').style.display = 'none';
        document.getElementById('bottomNav').style.display = 'none';

        document.getElementById('authOverlay').classList.add('active');
        this.showWelcomeScreen();

        document.getElementById('loginPhone').value = '';
        document.getElementById('loginPass').value = '';

        appNav.hideAllSections();
        document.getElementById('viewDashboard').style.display = 'block';
        document.querySelector('.nav-item[data-target="viewDashboard"]').classList.add('active');
    },
    
    deleteAccount: async function() {
        if (!this.currentUserPhone || this.currentUserPhone === 'Rupam') return;

        if (confirm("⚠️ WARNING: Permanently delete your account and ALL associated information (Profiles, Health Data, Logs, Alerts) from the database?")) {
            await appDatabase.deleteUserAndData(this.currentUserPhone, this.currentSelectedRole);
            alert("Account and all associated information successfully deleted from the database.");
            this.logout();
        }
    },
    
    signup: async function() {
        if (this.currentSelectedRole === 'Admin') {
            alert("Admin creation is restricted to developers only.");
            return;
        }

        const familyPassword = document.getElementById('signupPass').value; 

        let primaryRelSelect = document.getElementById('signupRelation').value;
        let primaryRelation = primaryRelSelect === 'Other' ? document.getElementById('signupRelationOther').value.trim() : primaryRelSelect;

        const primaryMember = {
            name: document.getElementById('signupName').value.trim(),
            phone: document.getElementById('signupPhone').value.trim(),
            pass: familyPassword,
            relation: primaryRelation,
            email: document.getElementById('signupEmail').value.trim()
        };

        if(!primaryMember.name || !primaryMember.phone || !primaryMember.pass || !primaryMember.relation) { 
            alert("Please fill in all required (*) fields for the primary Care Family member."); 
            return; 
        }

        let familyDataToSave = [primaryMember];

        const extraBlocks = document.querySelectorAll('.extra-fam-block');
        for (let block of extraBlocks) {
            const name = block.querySelector('.fam-name').value.trim();
            const phone = block.querySelector('.fam-phone').value.trim();
            
            let dynRelSelect = block.querySelector('.fam-relation').value;
            let dynRelation = dynRelSelect === 'Other' ? block.querySelector('.fam-relation-other').value.trim() : dynRelSelect;
            const email = block.querySelector('.fam-email').value.trim();

            if(name && phone && dynRelation) {
                familyDataToSave.push({name, phone, pass: familyPassword, relation: dynRelation, email});
            }
        }

        for (let member of familyDataToSave) {
            const { error } = await appDatabase.saveUser({
                name: member.name,
                phone: member.phone,
                role: this.currentSelectedRole,
                password: member.pass
            });
            if (error) console.warn(`Error registering ${member.name}: `, error.message);
        }

        alert(`Care Family accounts successfully recorded to Database! Proceeding to setup the Care Focus (Patient).`);
        
        this.currentUserPhone = primaryMember.phone;
        document.getElementById('authOverlay').classList.remove('active');
        document.getElementById('currentUserDisplay').innerText = primaryMember.name;
        document.getElementById('navAdminDashboard').style.display = "none"; 

        onboardingWizard.tempFamily = familyDataToSave.map(m => ({
            name: m.name,
            phone: m.phone,
            relation: m.relation,
            email: m.email
        }));

        appNav.startOnboarding();
    }
};

document.getElementById('tabSignup').onclick = (e) => {
    e.target.classList.add('active');
    document.getElementById('tabLogin').classList.remove('active');
    document.getElementById('formSignup').style.display = 'block';
    document.getElementById('formLogin').style.display = 'none';
};
document.getElementById('tabLogin').onclick = (e) => {
    e.target.classList.add('active');
    document.getElementById('tabSignup').classList.remove('active');
    document.getElementById('formLogin').style.display = 'block';
    document.getElementById('formSignup').style.display = 'none';
};

// --- View Navigation (Bottom Nav) ---
const navItems = document.querySelectorAll('.nav-item');
const viewSections = document.querySelectorAll('.view-section');

navItems.forEach(item => {
    item.addEventListener('click', () => {
        const targetView = item.getAttribute('data-target');
        navItems.forEach(nav => nav.classList.remove('active'));
        item.classList.add('active');
        viewSections.forEach(section => {
            section.style.display = section.id === targetView ? 'block' : 'none';
            if (section.id === targetView) {
                const animatedElements = section.querySelectorAll('.fade-in-up, .pop-in');
                animatedElements.forEach(el => {
                    el.style.animation = 'none';
                    void el.offsetWidth;
                    el.style.animation = null;
                });
            }
        });
        if(targetView === 'viewProfile') loadProfiles();
        if(targetView === 'viewTimeline') renderTimeline();
    });
});

// --- Hardware Tab Logic & Connectivity (see device-link.js) ---
const btnTabRemote = document.getElementById('tabRemote');
const btnTabBLE = document.getElementById('tabBLE');
const btnTabWiFi = document.getElementById('tabWiFi');
const remoteSetup = document.getElementById('remoteSetup');
const bleSetup = document.getElementById('bleSetup');
const wifiSetup = document.getElementById('wifiSetup');
const connStatus = document.getElementById('connStatus');
const connDetail = document.getElementById('connDetail');
const btnDisconnect = document.getElementById('btnDisconnect');
const ipAddress = document.getElementById('ipAddress');
const btnConnectWiFi = document.getElementById('btnConnectWiFi');
const pairCodeInput = document.getElementById('pairCode');

const linkUI = {
    tab: 'remote',
    showTab(tab) {
        this.tab = tab;
        btnTabRemote.classList.toggle('active', tab === 'remote');
        btnTabBLE.classList.toggle('active', tab === 'ble');
        btnTabWiFi.classList.toggle('active', tab === 'local');
        remoteSetup.style.display = tab === 'remote' ? 'block' : 'none';
        bleSetup.style.display = tab === 'ble' ? 'block' : 'none';
        wifiSetup.style.display = tab === 'local' ? 'block' : 'none';
        if (tab === 'local' && location.protocol === 'https:') linkMsg('localMsg', 'Note: on this https:// page the browser blocks Local Wi-Fi. Use Remote instead (it works on the same network too).', 'error');
        if (tab === 'ble' && !deviceLink.bleSupported()) linkMsg('bleMsg', 'This browser has no Web Bluetooth. Use Chrome or Edge on Windows, macOS, Android or ChromeOS (not iPhone/Safari/Firefox).', 'error');
    },
    fillSettingsForm() {
        const st = deviceLink.settings;
        pairCodeInput.value = st.code || '';
        if (!ipAddress.value) ipAddress.value = st.lastIp || '';
        const f = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
        f('setPairCode', st.code); f('setBroker', st.broker); f('setBrokerUser', st.user); f('setBrokerPass', st.pass);
    },
    saveSettings() {
        const code = document.getElementById('setPairCode').value.trim().toUpperCase();
        if (code && !deviceLink.parseCode(code)) return alert('That pairing code does not look right. It is shown in the device log as TCxxxxxxxxxxxx-XXXXXXXXXX.');
        const broker = document.getElementById('setBroker').value.trim() || 'wss://broker.emqx.io:8084/mqtt';
        if (!/^wss?:\/\//.test(broker)) return alert('The broker URL must start with wss:// (or ws:// for testing).');
        deviceLink.updateSettings({ code, broker,
            user: document.getElementById('setBrokerUser').value.trim(),
            pass: document.getElementById('setBrokerPass').value });
        this.fillSettingsForm();
        if (code) deviceLink.connectRemote();
        alert('Saved. Reconnecting to the device…');
    },
    // Called after login: reconnect to the paired device automatically
    autoConnect() {
        this.fillSettingsForm();
        const st = deviceLink.settings;
        if (st.code && st.autoRemote) deviceLink.connectRemote();
        this.showTab(st.code ? 'remote' : (deviceLink.bleSupported() ? 'ble' : 'remote'));
    },
    render(state) {
        const on = deviceLink.anyConnected();
        const busy = ['remote', 'ble', 'local'].some(k => state[k] === 'connecting');
        const via = state.ble === 'on' ? 'Bluetooth' : state.local === 'on' ? 'Local Wi-Fi' : state.remote === 'on' ? 'Remote' : '';
        const icon = document.getElementById('connIcon');
        if (on && state.remote === 'on' && state.ble !== 'on' && state.local !== 'on' && state.deviceOnline === false) {
            connStatus.innerText = 'Device offline';
            connStatus.className = 'text-orange';
            icon.className = 'icon-circle glow-orange';
        } else if (on) {
            connStatus.innerText = 'Connected · ' + via;
            connStatus.className = 'text-green';
            icon.className = 'icon-circle glow-green';
        } else if (busy) {
            connStatus.innerText = 'Connecting…';
            connStatus.className = 'text-orange';
            icon.className = 'icon-circle glow-orange';
        } else {
            connStatus.innerText = 'Disconnected';
            connStatus.className = 'text-red';
            icon.className = 'icon-circle glow-red';
        }
        icon.innerHTML = state.ble === 'on' ? '<i class="fa-brands fa-bluetooth-b"></i>'
                       : state.local === 'on' ? '<i class="fa-solid fa-wifi"></i>' : '<i class="fa-solid fa-globe"></i>';
        const chip = (id, st) => { const el = document.getElementById(id); el.className = 'link-chip chip-' + st; };
        chip('chipRemote', state.remote === 'on' && state.deviceOnline === false ? 'error' : state.remote);
        chip('chipBLE', state.ble);
        chip('chipLocal', state.local);
        btnDisconnect.disabled = !(on || busy);
        document.getElementById('btnDeviceWifi').disabled = !(state.ble === 'on' || state.remote === 'on' || state.local === 'on');
        const badge = document.getElementById('hwLinkBadge');
        if (badge) { badge.innerText = on ? via : 'Offline'; badge.className = on ? 'badge-green pulse' : 'badge-orange'; }
        if (!on && !busy) resetLiveTiles();
    },
    renderStatus(st) {
        const parts = [];
        if (st.name) parts.push(st.name);
        if (st.ssid) parts.push((st.wifi ? '' : 'joining ') + st.ssid + (st.rssi ? ` (${st.rssi} dBm)` : ''));
        if (st.cloud) parts.push('Cloud: ' + st.cloud);
        connDetail.innerText = parts.join(' · ') || 'ESP32-P4 + RD-03D';
        document.getElementById('devNetInfo').innerText = st.ssid
            ? `Current network: ${st.ssid}${st.wifi ? ' — connected' : ' — not connected'}${st.ip ? ' · IP ' + st.ip : ''}`
            : 'Current network: none';
        if (st.ip && !ipAddress.value) ipAddress.value = st.ip;
    }
};

function resetLiveTiles() {
    document.getElementById('valActivity').innerText = "Waiting...";
    document.getElementById('valActivity').className = "text-muted";
    document.getElementById('mainPredIcon').className = "fa-solid fa-spinner fa-spin text-muted";
    document.getElementById('mainPredIcon').parentElement.className = "pred-icon-large";
    document.querySelectorAll('.act-box').forEach(b => b.classList.remove('active'));
    document.getElementById('valAudio').innerText = "Waiting...";
    document.getElementById('valAudio').className = "text-muted";
    document.getElementById('mainAudioIcon').className = "fa-solid fa-spinner fa-spin text-muted";
    document.getElementById('mainAudioIcon').parentElement.className = "pred-icon-large";
    document.querySelectorAll('.aud-box').forEach(b => b.classList.remove('active'));
}
// kept for older call sites
function setDisconnected() { resetLiveTiles(); }

deviceLink.on('state', (st) => linkUI.render(st));
deviceLink.on('live', (msg) => updateUI(msg));
deviceLink.on('status', (st) => linkUI.renderStatus(st));
deviceLink.on('rtt', ({ ms }) => { document.querySelector('#chipLatency span').innerText = ms + ' ms'; });
deviceLink.on('tick', ({ ageMs }) => {
    const el = document.querySelector('#chipAge span');
    if (ageMs == null) { el.innerText = '–'; return; }
    const s = Math.round(ageMs / 1000);
    el.innerText = s < 1 ? 'now' : s + ' s ago';
    document.getElementById('chipAge').classList.toggle('chip-error', ageMs > deviceLink.STALE_AFTER_MS);
});
deviceLink.on('paired', (msg) => {
    pairCodeInput.value = msg.code;
    linkUI.fillSettingsForm();
    connDetail.innerText = 'Paired: ' + msg.code + ' — Remote now works from any network';
});
deviceLink.on('need-pairing', () => {
    connDetail.innerText = 'Enter the pairing code, or pair once over Bluetooth';
});
deviceLink.on('decrypt-error', () => {
    connDetail.innerText = 'Messages cannot be decrypted — check the pairing code';
});
deviceLink.on('warn', (m) => { connDetail.innerText = m; });
deviceLink.on('scan', (aps) => {
    const sel = document.getElementById('devWifiSsidList');
    sel.innerHTML = '<option value="">' + (aps.length ? 'Choose a network…' : 'No networks found') + '</option>' +
        aps.map(a => `<option value="${aiChat.escapeHTML(a.s)}">${aiChat.escapeHTML(a.s)} (${a.r} dBm${a.o ? ', open' : ''})</option>`).join('');
    document.getElementById('devWifiMsg').innerText = aps.length ? `${aps.length} networks found.` : '';
});
deviceLink.on('ack', (m) => {
    if (m.cmd === 'pair' && !m.ok) {
        connDetail.innerText = 'Pairing window closed — switch the device off and on, then connect over Bluetooth again (or type the code)';
        return;
    }
    document.getElementById('devWifiMsg').innerText = (m.ok ? '✔ ' : '✖ ') + (m.msg || m.cmd);
});

btnTabRemote.addEventListener('click', () => linkUI.showTab('remote'));
btnTabBLE.addEventListener('click', () => linkUI.showTab('ble'));
btnTabWiFi.addEventListener('click', () => linkUI.showTab('local'));

document.getElementById('btnConnectRemote').addEventListener('click', () => {
    const code = pairCodeInput.value.trim().toUpperCase();
    if (!deviceLink.parseCode(code)) return alert('Enter the pairing code shown in the device log (TCxxxxxxxxxxxx-XXXXXXXXXX), or pair over Bluetooth.');
    deviceLink.updateSettings({ code, autoRemote: true });
    deviceLink.connectRemote();
});

function linkMsg(id, text, kind) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text || '';
    el.className = 'link-hint small link-msg' + (kind ? ' is-' + kind : '');
}

function bleErrorText(err) {
    const m = String((err && err.message) || '');
    if (!deviceLink.bleSupported()) return m;
    if (err && err.name === 'NotFoundError' && /cancel/i.test(m))
        return 'No device chosen. If the list was empty: the device is off, too far away, or its Bluetooth has not started (check the device log for "live_ble: advertising").';
    if (err && err.name === 'NotFoundError') return 'Bluetooth is off or not available on this computer. Turn Bluetooth on in the system settings and try again.';
    if (err && err.name === 'SecurityError') return 'The browser blocked Bluetooth on this page. Open the app over https:// or http://localhost in Chrome or Edge.';
    if (err && err.name === 'NetworkError') return 'The device was found but the connection dropped. Move closer and try again.';
    return m || 'Bluetooth connection failed.';
}

document.getElementById('btnConnectBLE').addEventListener('click', async () => {
    const btn = document.getElementById('btnConnectBLE');
    linkMsg('bleMsg', 'Choose your device in the browser window (ESP32-TempoCare-…)…');
    btn.disabled = true;
    try {
        const name = await deviceLink.connectBLE();
        linkMsg('bleMsg', 'Connected to ' + name + '.', 'ok');
    } catch (err) {
        console.error("BLE Error:", err);
        linkMsg('bleMsg', bleErrorText(err), 'error');
    } finally {
        btn.disabled = false;
    }
});

btnConnectWiFi.addEventListener('click', () => {
    const ip = ipAddress.value.trim();
    if (!ip) return linkMsg('localMsg', 'Enter the device IP address (shown on the device card and in the device log).', 'error');
    const local = /^(localhost|127\.)/.test(ip.replace(/^wss?:\/\//, ''));
    if (location.protocol === 'https:' && !local) {
        return linkMsg('localMsg', 'Local Wi-Fi cannot work on this https:// page: browsers block plain ws:// connections from secure sites. ' +
            'Use the Remote tab (it also works on the same network), or open the app from http:// on a computer in the same network.', 'error');
    }
    linkMsg('localMsg', 'Connecting to ws://' + ip + ' …');
    try { deviceLink.connectLocal(ip); }
    catch (e) { linkMsg('localMsg', e.message, 'error'); }
});

deviceLink.on('state', (st) => {
    if (st.local === 'on') linkMsg('localMsg', 'Connected.', 'ok');
    else if (st.local === 'error' || (st.local === 'connecting' && deviceLink.state.localFailures > 0))
        linkMsg('localMsg', 'Cannot reach the device at that address. Check that it is on the same Wi-Fi network, the IP is current, and port 81 is not blocked. Retrying…', 'error');
});

btnDisconnect.addEventListener('click', () => {
    deviceLink.updateSettings({ autoRemote: false });
    deviceLink.disconnectAll();
    resetLiveTiles();
});

// Device Wi-Fi card
document.getElementById('btnDeviceWifi').addEventListener('click', () => {
    const card = document.getElementById('deviceWifiCard');
    card.style.display = card.style.display === 'none' ? 'block' : 'none';
});
document.getElementById('btnCloseDeviceWifi').addEventListener('click', () => {
    document.getElementById('deviceWifiCard').style.display = 'none';
});
document.getElementById('devWifiSsidList').addEventListener('change', (e) => {
    if (e.target.value) document.getElementById('devWifiSsid').value = e.target.value;
});
document.getElementById('btnScanWifi').addEventListener('click', async () => {
    document.getElementById('devWifiMsg').innerText = 'Scanning… (about 3 s)';
    try { await deviceLink.scanWifi(); } catch (e) { document.getElementById('devWifiMsg').innerText = e.message; }
});
document.getElementById('btnSendWifi').addEventListener('click', async () => {
    const ssid = document.getElementById('devWifiSsid').value.trim();
    const pass = document.getElementById('devWifiPass').value;
    if (!ssid) return alert('Enter or choose the network name.');
    if (pass && pass.length < 8) return alert('Wi-Fi passwords are at least 8 characters.');
    const via = deviceLink.state.ble === 'on' ? 'Bluetooth' : 'the current link';
    if (deviceLink.state.ble !== 'on' &&
        !confirm(`Move the device to "${ssid}"? It will drop off ${via} for a few seconds while it switches.`)) return;
    try {
        await deviceLink.setWifi(ssid, pass);
        document.getElementById('devWifiMsg').innerText = 'Sent. The device is switching networks…';
        document.getElementById('devWifiPass').value = '';
    } catch (e) { document.getElementById('devWifiMsg').innerText = e.message; }
});

linkUI.fillSettingsForm();

// --- Local AI Chatbot Engine ---
const aiChat = {
    clearChat: function() {
        const container = document.getElementById('chatContainer');
        container.innerHTML = `
            <div class="chat-msg bot-msg pop-in">
                Chat cleared. I am ready to answer queries natively by securely analyzing your local health and radar database records.
            </div>
        `;
    },

    askSuggested: function(queryText) {
        document.getElementById('chatInput').value = queryText;
        this.sendQuery();
    },

    sendQuery: async function() {
        const input = document.getElementById('chatInput');
        const text = input.value.trim();
        if(!text) return;

        const chatContainer = document.getElementById('chatContainer');
        chatContainer.innerHTML += `<div class="chat-msg user-msg pop-in">${this.escapeHTML(text)}</div>`;
        input.value = '';
        chatContainer.scrollTop = chatContainer.scrollHeight;

        const typingId = "botTyping_" + Date.now();
        chatContainer.innerHTML += `
            <div class="chat-msg bot-msg pop-in" id="${typingId}">
                <i class="fa-solid fa-spinner fa-spin text-cyan"></i> AI is scanning the database...
            </div>
        `;
        chatContainer.scrollTop = chatContainer.scrollHeight;

        try {
            const [profiles, healthList, activityLogs, alerts] = await Promise.all([
                appDatabase.getProfiles(),
                appDatabase.getHealthProfiles(),
                appDatabase.getActivityLogs(50),
                appDatabase.getAlerts()
            ]);

            const primaryProfile = profiles.length > 0 ? profiles[0] : null;
            const primaryHealth = healthList.length > 0 ? healthList[0] : null;

            setTimeout(() => {
                let botReply = this.generateLocalResponse(text.toLowerCase(), primaryProfile, primaryHealth, activityLogs, alerts);
                
                const formattedReply = this.formatMarkdown(botReply);
                const typingEl = document.getElementById(typingId);
                if (typingEl) {
                    typingEl.innerHTML = formattedReply;
                    typingEl.classList.add('pop-in');
                }
                chatContainer.scrollTop = chatContainer.scrollHeight;
            }, 1200);

        } catch (error) {
            const typingEl = document.getElementById(typingId);
            if (typingEl) typingEl.innerHTML = `<span style="color: var(--accent-red);"><i class="fa-solid fa-triangle-exclamation"></i> Error connecting to the database: ${error.message}</span>`;
            chatContainer.scrollTop = chatContainer.scrollHeight;
        }
    },

    generateLocalResponse: function(query, profile, health, logs, alerts) {
        if (!profile) return "I don't have any Care Focus profiles registered yet. Please add one first from the Profiles tab.";
        
        let response = "";

        if (query.includes("latest") || query.includes("recent activity") || query.includes("doing")) {
            if (logs && logs.length > 0) {
                let latest = logs[0];
                let time = new Date(latest.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                response = `Based on the latest sensor records, the most recent activity was **${latest.activity.replace(/_/g, ' ')}** at ${time}.`;
                if (logs.length > 1) {
                    response += ` Just prior to that, the system logged **${logs[1].activity.replace(/_/g, ' ')}**.`;
                }
            } else {
                response = "There are no recent activities logged in the database yet.";
            }
        } 
        else if (query.includes("summary") || query.includes("transitions") || query.includes("pattern")) {
            if (logs && logs.length > 0) {
                let acts = logs.slice(0, 5).reverse().map(l => l.activity.replace(/_/g, ' ')).join(" ➔ ");
                response = `Here is a summary of the most recent transitions from the database:\n\n**${acts}**\n\nThe pattern appears consistent with regular movement based on recent sensor data.`;
            } else {
                response = "I don't have enough data to generate a sequence summary right now.";
            }
        }
        else if (query.includes("blood sugar") || query.includes("diabetes") || query.includes("vitals")) {
            if (health) {
                response = `**Blood Sugar & Vitals for ${profile.name}:**\n`;
                response += `- **Diabetes Condition:** ${health.has_diabetes ? "Yes" : "No"}\n`;
                if (health.hba1c) response += `- **HbA1c:** ${health.hba1c}%\n`;
                if (health.sugar_fasting) response += `- **Fasting Sugar:** ${health.sugar_fasting} mg/dL\n`;
                if (health.sugar_postprandial) response += `- **Post-meal:** ${health.sugar_postprandial} mg/dL\n`;
                if (health.takes_diab_med && health.diab_med_name) {
                    response += `- **Medication:** ${health.diab_med_name} (${health.diab_med_freq})\n`;
                }
            } else {
                response = "I don't have any medical health records registered for this profile yet.";
            }
        }
        else if (query.includes("bp") || query.includes("blood pressure") || query.includes("pressure")) {
            if (health) {
                response = `**Blood Pressure Records for ${profile.name}:**\n`;
                response += `- **BP Issue Identified:** ${health.has_bp ? "Yes" : "No"}\n`;
                if (health.bp_systolic && health.bp_diastolic) {
                    response += `- **Last Reading:** ${health.bp_systolic} / ${health.bp_diastolic} mmHg (Recorded on ${health.bp_last_check || "N/A"})\n`;
                }
                if (health.takes_bp_med && health.bp_med_name) {
                    response += `- **Medication:** ${health.bp_med_name} (${health.bp_med_freq})\n`;
                }
            } else {
                response = "I don't have any health records registered for this profile.";
            }
        }
        else if (query.includes("mobility") || query.includes("fall") || query.includes("risk") || query.includes("walking")) {
            response = `**Mobility Assessment based on records:**\n`;
            if (health) {
                response += `- **Known Mobility Issues:** ${health.has_mobility_issue ? "Yes" : "No"}\n`;
                response += `- **Difficulty Sitting/Standing:** ${health.sitting_standing_difficulty ? "Yes" : "No"}\n`;
                response += `- **Assistance Required:** ${health.bathroom_assistance ? "Yes" : "No"}\n`;
            }
            if (alerts && alerts.length > 0) {
                response += `\n**Warning Alerts found:**\n- ${alerts[0].message} (${new Date(alerts[0].created_at).toLocaleString()})`;
            } else {
                response += "\n*No recent fall alerts or abnormal mobility patterns detected in the activity logs.*";
            }
        }
        else if (query.includes("contact") || query.includes("emergency") || query.includes("call")) {
            response = `**Emergency Contact Information:**\n- Primary Emergency Number: **${profile.emergency || "Not provided"}**\n`;
            if (profile.family_members && profile.family_members.length > 0) {
                response += "\n**Registered Care Family Members:**\n";
                profile.family_members.forEach(f => {
                    response += `- ${f.name} (${f.relation}): ${f.phone}\n`;
                });
            }
        }
        else if (query.includes("sleep") || query.includes("night") || query.includes("bathroom")) {
            if (health) {
                response = `**Sleep and Nighttime Activity:**\n`;
                response += `- **Sleep Issues Reported:** ${health.has_sleep_issue ? "Yes" : "No"}\n`;
                response += `- **Average Duration:** ${health.sleep_duration || "Unknown"} hours\n`;
                response += `- **Nighttime Bathroom Visits:** ${health.night_bathroom_frequency || 0} times on average\n`;
            } else {
                response = "I don't have sleep metrics registered for this profile.";
            }
        }
        else if (query.includes("hello") || query.includes("hi ") || query.includes("hey")) {
             response = `Hello! How can I assist you with ${profile.name}'s care today? I can pull the latest activity patterns or health stats directly from the database.`;
        }
        else {
            response = `I am currently analyzing the live database records for **${profile.name}**. I can instantly provide details on:\n\n- Latest radar activities and room transitions\n- Health records (BP, Sugar, Mobility)\n- Emergency contacts\n- Sleep and nighttime behaviors\n\nPlease try asking specifically about one of these topics!`;
        }

        return response;
    },

    escapeHTML: function(str) {
        return str.replace(/[&<>'"]/g, tag => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'}[tag] || tag));
    },

    formatMarkdown: function(text) {
        let html = this.escapeHTML(text);
        html = html.replace(/\*\*(.*?)\*\*/g, '<strong style="color: var(--accent-cyan);">$1</strong>');
        html = html.replace(/\*(.*?)\*/g, '<em style="color: var(--accent-purple);">$1</em>');
        html = html.replace(/\n/g, '<br>');
        return html;
    }
};

// --- Updated UI Helper Functions ---
function getIconClass(act) {
    const map = {
        "Standing": "fa-person", "Sitting": "fa-chair", "Stand_To_Sit": "fa-arrow-down", 
        "Sit_To_Stand": "fa-arrow-up", "Walking": "fa-person-walking", "Entry": "fa-door-open", 
        "Exit": "fa-door-closed", "No_Person": "fa-user-slash"
    };
    return map[act] || "fa-spinner fa-spin";
}

// Maps exact audio class values to FontAwesome icons
function getAudioIconClass(aud) {
    const map = {
        walkercrutch: "fa-person-walking-with-cane", walker: "fa-person-walking-with-cane",
        bathroomtap: "fa-faucet-drip", basintap: "fa-sink",
        flush: "fa-toilet", flash: "fa-toilet",
        shower: "fa-shower", door: "fa-door-closed",
        noclass: "fa-microphone-slash"
    };
    return map[String(aud || '').toLowerCase().replace(/[\s_\-]/g, '')] || "fa-spinner fa-spin";
}

async function renderTimeline() {
    const logs = await appDatabase.getActivityLogs(20);
    const container = document.getElementById('timelineContainer');
    if(logs.length === 0) { container.innerHTML = "<li>No activities logged yet.</li>"; return; }
    container.innerHTML = logs.map(log => 
        `<li class="pop-in"><strong class="text-cyan" style="font-size: 1.1rem;">${log.activity.replace(/_/g, ' ')}</strong> <br><small class="text-muted">${new Date(log.created_at).toLocaleString()}</small></li>`
    ).join('');
}

async function loadProfiles() {
    const profiles = await appDatabase.getProfiles();
    const list = document.getElementById('profileList');
    if(profiles.length === 0) { list.innerHTML = "<p class='text-muted' style='text-align:center;'>No profiles found. Add one with the Add button above.</p>"; return; }
    list.innerHTML = profiles.map(p => 
        `<div class="stat-item glass-sub-panel pop-in hover-scale-subtle" style="border-left: 4px solid var(--accent-cyan);">
            <div class="icon-circle glow-cyan" style="width: 50px; height: 50px; font-size: 1.4rem; overflow: hidden; padding: 0;">
                ${p.photo_data ? `<img src="${p.photo_data}" style="width: 100%; height: 100%; object-fit: cover;">` : `<i class="fa-solid fa-user"></i>`}
            </div>
            <div style="flex: 1; margin-left: 15px;">
                <strong class="text-main" style="font-size: 1.1rem;">${p.name}</strong> <span class="text-muted">(Age: ${p.age} / ${p.gender})</span><br>
                <small class="text-cyan">Family Members Attached: <span style="font-weight: 700;">${p.family_members ? p.family_members.length : 0}</span></small>
            </div>
            <button class="del-btn hover-scale" onclick="appNav.deleteProfile(${p.id})"><i class="fa-solid fa-trash"></i></button>
        </div>`
    ).join('');
}

// --- AI Backtracking Logic (Mirrored from Firmware) ---
const activityTracker = {
    HISTORY_SIZE: 150,
    historyBuffer: [],
    lastTrackedState: "No_Person",
    backtrackTimer: null,

    logActivity: function(activity) {
        if (this.historyBuffer.length >= this.HISTORY_SIZE) this.historyBuffer.shift(); 
        
        this.historyBuffer.push({
            timestamp: Date.now(),
            originalActivity: activity,
            correctedActivity: activity,
            isCorrected: false
        });
        this.checkBacktracking(activity);
    },

    applyBacktracking: function(triggeringEvent, correctPastState, stopCond1, stopCond2) {
        let correctedCount = 0;
        for (let i = this.historyBuffer.length - 1; i >= 0; i--) {
            let entry = this.historyBuffer[i];
            if (entry.correctedActivity === stopCond1 || entry.correctedActivity === stopCond2) break;
            
            if (entry.correctedActivity !== correctPastState && entry.correctedActivity !== triggeringEvent && entry.correctedActivity !== "Loading Buffer...") {
                entry.correctedActivity = correctPastState;
                entry.isCorrected = true;
                correctedCount++;
            }
        }
        return correctedCount;
    },

    checkBacktracking: function(currentState) {
        if (currentState === this.lastTrackedState) return;

        let correctedFrames = 0;
        let correctionMsg = "";

        if (currentState === "Sit_To_Stand") {
            correctedFrames = this.applyBacktracking("Sit_To_Stand", "Sitting", "Stand_To_Sit", "Walking");
            correctionMsg = "Prior states corrected to 'Sitting' due to Sit-to-Stand trigger.";
        } 
        else if (currentState === "Stand_To_Sit") {
            correctedFrames = this.applyBacktracking("Stand_To_Sit", "Standing", "Sit_To_Stand", "Walking");
            correctionMsg = "Prior states corrected to 'Standing' due to Stand-to-Sit trigger.";
        }
        else if (currentState === "Sitting" && this.lastTrackedState === "Standing") {
            correctedFrames = this.applyBacktracking("Auto_Correct_to_Sit", "Sitting", "Stand_To_Sit", "Walking");
            correctionMsg = "Auto-corrected 'Standing' gap directly to 'Sitting'.";
        }
        else if (currentState === "Standing" && this.lastTrackedState === "Sitting") {
            correctedFrames = this.applyBacktracking("Auto_Correct_to_Stand", "Standing", "Sit_To_Stand", "Walking");
            correctionMsg = "Auto-corrected 'Sitting' gap directly to 'Standing'.";
        }

        this.lastTrackedState = currentState;

        if (correctedFrames > 0) {
            this.showBacktrackUI(correctionMsg, correctedFrames);
        }
    },

    showBacktrackUI: function(msg, frames) {
        const card = document.getElementById('uiBacktrackCard');
        const msgEl = document.getElementById('backtrackMsg');
        const detailsEl = document.getElementById('backtrackDetails');

        msgEl.innerText = msg;
        detailsEl.innerText = `${frames} historical frames retroactively updated.`;

        card.style.display = 'block';
        card.classList.remove('flash');
        void card.offsetWidth;
        card.classList.add('flash');

        clearTimeout(this.backtrackTimer);
        this.backtrackTimer = setTimeout(() => { card.style.display = 'none'; }, 6000);
    }
};

// --- Updated Unified Parser ---
let lastLoggedActivity = "";

function normLabel(x) { return String(x || '').toLowerCase().replace(/[\s_\-]/g, ''); }

function updateUI(dataStr) {
    try {
        const data = typeof dataStr === 'string' ? JSON.parse(dataStr) : dataStr;
        
        // --- 1. Parse Radar Motion Classification ---
        if (data.activity) {
            const elActivity = document.getElementById('valActivity');
            const mainPredIcon = document.getElementById('mainPredIcon');
            const mainPredIconWrap = mainPredIcon.parentElement;
            const activityBoxes = document.querySelectorAll('.act-box');

            elActivity.innerText = data.activity.replace(/_/g, ' ');
            elActivity.className = "pred-text text-gradient-blue-purple";
            mainPredIcon.className = "fa-solid " + getIconClass(data.activity);
            
            // Re-apply glowing pulse
            mainPredIconWrap.className = "pred-icon-large pulse-glow-purple";

            activityBoxes.forEach(box => {
                if (box.dataset.act === data.activity) box.classList.add('active');
                else box.classList.remove('active');
            });

            activityTracker.logActivity(data.activity);

            if(data.activity !== lastLoggedActivity && data.activity !== "Loading Buffer...") {
                appDatabase.logActivity(data.activity, appState.activeProfileId);
                lastLoggedActivity = data.activity;
            }
        }

        // --- 2. Parse Audio Classification ---
        if (data.audio) {
            const elAudio = document.getElementById('valAudio');
            const mainAudioIcon = document.getElementById('mainAudioIcon');
            const mainAudioIconWrap = mainAudioIcon.parentElement;
            const audioBoxes = document.querySelectorAll('.aud-box');

            // Format title by removing underscores for display (e.g., 'bathroom_tap' -> 'bathroom tap')
            let displayAudioName = data.audio.replace(/_/g, ' ');
            if (data.audio.toLowerCase() === 'flash') displayAudioName = "Flush"; // Automatically correct visual typo on the dashboard
            if (normLabel(data.audio) === 'walkercrutch') displayAudioName = "Walker / Crutch";
            if (normLabel(data.audio) === 'noclass') displayAudioName = "No Class";
            if (typeof data.aconf === 'number') displayAudioName += ` · ${Math.round(data.aconf * 100)}%`;

            elAudio.innerText = displayAudioName;
            elAudio.className = "pred-text text-gradient-cyan-blue";
            mainAudioIcon.className = "fa-solid " + getAudioIconClass(data.audio);
            
            // Re-apply glowing pulse
            mainAudioIconWrap.className = "pred-icon-large pulse-glow-cyan";

            audioBoxes.forEach(box => {
                // Allows matching whether the ESP32 sends it with spaces or underscores
                const standardizedDataAud = normLabel(box.dataset.aud);
                let standardizedIncomingAud = normLabel(data.audio);
                if (standardizedIncomingAud === 'flash') standardizedIncomingAud = 'flush';
                
                if (standardizedDataAud === standardizedIncomingAud) {
                    box.classList.add('active');
                } else {
                    box.classList.remove('active');
                }
            });
        }
        
    } catch (e) {
        console.warn("Error parsing UI update:", e);
    }
}