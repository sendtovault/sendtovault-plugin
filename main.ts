import { App, Plugin, PluginSettingTab, Setting, Notice, requestUrl, WorkspaceLeaf, ItemView, TFile } from 'obsidian';
import { FirstRunModal, PaywallModal, QuotaPanel, RegistrationResponse } from './ui/components';

interface SendToVaultSettings {
	uid: string;
	jwt: string;
	alias: string;
	lastSyncIso: string;
	autoOpenImported: boolean;
	quotaUsed: number;
	quotaLimit: number;
	importsThisMonth: number;
	vaultIdentifier: string;
}

const DEFAULT_SETTINGS: SendToVaultSettings = {
	uid: '',
	jwt: '',
	alias: '',
	lastSyncIso: '',
	autoOpenImported: true,
	quotaUsed: 0,
	quotaLimit: 100,
	importsThisMonth: 0,
	vaultIdentifier: ''
}

interface Note {
	id: string;
	title: string;
	markdown: string;
	created_iso: string;
}

interface DownloadResponse {
	notes: Note[];
	over_quota: boolean;
	quota_used?: number;
	quota_limit?: number;
}

const VIEW_TYPE_SENDTOVAULT = 'sendtovault-quota-panel';

class SendToVaultView extends ItemView {
	private quotaPanel: QuotaPanel;
	private plugin: SendToVaultPlugin;

	constructor(leaf: WorkspaceLeaf, plugin: SendToVaultPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return VIEW_TYPE_SENDTOVAULT;
	}

	getDisplayText() {
		return 'SendToVault';
	}

	async onOpen() {
		const container = this.containerEl.children[1];
		container.empty();
		this.quotaPanel = new QuotaPanel(container as HTMLElement, () => this.plugin.forceSync());
		this.quotaPanel.load();
	}

	async onClose() {
		if (this.quotaPanel) {
			this.quotaPanel.unload();
		}
	}

	updateQuota(used: number, limit: number, importsThisMonth: number) {
		if (this.quotaPanel) {
			this.quotaPanel.updateQuota(used, limit, importsThisMonth);
		}
	}
}

export default class SendToVaultPlugin extends Plugin {
	settings: SendToVaultSettings;
	private pollingInterval: number | undefined;
	private ribbonIconEl: HTMLElement;
	private retryDelay: number = 10 * 1000; // 10 seconds initial
	private maxRetryDelay: number = 30 * 60 * 1000; // 30 minutes max
	private visibilityChangeHandler: () => void;

	async onload() {
		await this.loadSettings();

		// Register the quota panel view
		this.registerView(
			VIEW_TYPE_SENDTOVAULT,
			(leaf: WorkspaceLeaf) => new SendToVaultView(leaf, this)
		);

		// Create ribbon icon with badge
		this.ribbonIconEl = this.addRibbonIcon('mail', 'SendToVault', (evt: MouseEvent) => {
			this.toggleQuotaPanel();
		});
		this.updateRibbonBadge();

		// Add settings tab
		this.addSettingTab(new SendToVaultSettingTab(this.app, this));

		// Set up visibility change handler
		this.visibilityChangeHandler = () => {
			if (!document.hidden) {
				console.log('SendToVault: Document became visible, triggering immediate poll');
				this.poll();
			}
		};
		document.addEventListener('visibilitychange', this.visibilityChangeHandler);

		// Initialize or start polling
		if (!this.settings.uid || !this.settings.jwt) {
			await this.registerWithService();
		} else {
			this.startPolling();
		}
	}

	onunload() {
		this.stopPolling();
		// Remove visibility change listener
		if (this.visibilityChangeHandler) {
			document.removeEventListener('visibilitychange', this.visibilityChangeHandler);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		
		// Generate vault identifier if it doesn't exist
		if (!this.settings.vaultIdentifier) {
			this.settings.vaultIdentifier = this.generateVaultIdentifier();
			await this.saveSettings();
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private generateVaultIdentifier(): string {
		// Use vault name and generate a random UUID for uniqueness
		const vaultName = this.app.vault.getName();
		const randomId = crypto.randomUUID();
		
		// Create identifier using vault name and random UUID
		const identifier = `${vaultName}-${randomId}`;
		
		console.log('SendToVault: Generated vault identifier:', identifier);
		return identifier;
	}

	private async registerWithService(rotate: boolean = false): Promise<void> {
		try {
			console.log('SendToVault: Starting registration...', { rotate });
			
			const url = rotate 
				? 'https://api.sendtovault.com/v1/register?rotate=true'
				: 'https://api.sendtovault.com/v1/register';
			
			console.log('SendToVault: Making request to:', url);
			
			const response = await requestUrl({
				url,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					client_version: this.manifest.version,
					vault_identifier: this.settings.vaultIdentifier
				})
			});

			console.log('SendToVault: Response status:', response.status);
			console.log('SendToVault: Response data:', response.json);

			const data: RegistrationResponse = response.json;
			
			// Validate response data - updated for new API format
			if (!data.email_address || !data.passkey || !data.vault_id) {
				throw new Error(`Invalid response data: ${JSON.stringify(data)}`);
			}
			
			// Map new API response to existing settings structure
			this.settings.uid = data.vault_id;
			this.settings.jwt = data.passkey;
			this.settings.alias = data.email_address;
			await this.saveSettings();

			console.log('SendToVault: Registration successful');

			if (!rotate) {
				// Show first-run modal
				new FirstRunModal(this.app, data, () => {
					this.startPolling();
				}).open();
			} else {
				new Notice('Email alias rotated successfully!');
			}
		} catch (error) {
			console.error('SendToVault registration failed:', error);
			
			// More detailed error reporting
			let errorMessage = 'Failed to register with SendToVault.';
			
			if (error instanceof Error) {
				if (error.message.includes('fetch')) {
					errorMessage += ' Network connection failed. Check your internet connection.';
				} else if (error.message.includes('Invalid response')) {
					errorMessage += ' Server returned invalid data.';
				} else if (error.message.includes('status')) {
					errorMessage += ` Server error: ${error.message}`;
				} else {
					errorMessage += ` Error: ${error.message}`;
				}
			}
			
			new Notice(errorMessage, 8000); // Show for 8 seconds
			
			// Also log the full error details
			console.error('Full error details:', {
				message: error.message,
				stack: error.stack,
				name: error.name
			});
		}
	}

	private startPolling(): void {
		console.log('SendToVault: Starting polling...');
		this.stopPolling();
		
		// Immediate first poll
		this.poll();
		
		// Set up interval for subsequent polls
		console.log(`SendToVault: Setting up polling interval: ${this.retryDelay}ms`);
		this.pollingInterval = window.setInterval(() => {
			console.log('SendToVault: Interval triggered, calling poll()');
			this.poll();
		}, this.retryDelay);
		
		console.log('SendToVault: Polling started with interval ID:', this.pollingInterval);
	}

	private stopPolling(): void {
		if (this.pollingInterval) {
			console.log('SendToVault: Stopping polling, clearing interval:', this.pollingInterval);
			window.clearInterval(this.pollingInterval);
			this.pollingInterval = undefined;
		}
	}

	private async poll(): Promise<void> {
		// Rate limit if Obsidian is not active
		if (document.hidden) {
			console.log('SendToVault: Skipping poll - document hidden');
			return;
		}

		const pollStartTime = Date.now();
		console.log('SendToVault: Starting poll at', new Date().toISOString());

		try {
			console.log('SendToVault: Poll request data:', {
				vault_identifier: this.settings.vaultIdentifier,
				passkey: this.settings.jwt ? '***' : 'empty',
				since: this.settings.lastSyncIso || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
			});

			const response = await requestUrl({
				url: 'https://api.sendtovault.com/v1/download',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					vault_identifier: this.settings.vaultIdentifier,
					passkey: this.settings.jwt,
					since: this.settings.lastSyncIso || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
				})
			});

			console.log('SendToVault: Poll response status:', response.status);
			console.log('SendToVault: Raw response data:', response.json);

			const data: DownloadResponse = response.json;
			
			// Debug the response structure
			console.log('SendToVault: Parsed response data:', {
				notes: data.notes ? `Array of ${data.notes.length} notes` : 'undefined/null',
				over_quota: data.over_quota,
				quota_used: data.quota_used,
				quota_limit: data.quota_limit
			});

			// Debug notes array in detail
			if (data.notes) {
				console.log('SendToVault: Notes array type:', typeof data.notes);
				console.log('SendToVault: Notes array is array?', Array.isArray(data.notes));
				console.log('SendToVault: Notes array length:', data.notes.length);
				
				if (data.notes.length > 0) {
					console.log('SendToVault: First note structure:', {
						id: data.notes[0].id,
						title: data.notes[0].title,
						markdown_length: data.notes[0].markdown ? data.notes[0].markdown.length : 'undefined',
						created_iso: data.notes[0].created_iso
					});
				} else {
					console.log('SendToVault: Notes array is empty - no new notes to process');
				}
			} else {
				console.log('SendToVault: Notes is null, undefined, or not an array - no new notes to process');
			}
			
			// Update quota information
			if (data.quota_used !== undefined) {
				console.log('SendToVault: Updating quota_used from', this.settings.quotaUsed, 'to', data.quota_used);
				this.settings.quotaUsed = data.quota_used;
			}
			if (data.quota_limit !== undefined) {
				console.log('SendToVault: Updating quota_limit from', this.settings.quotaLimit, 'to', data.quota_limit);
				this.settings.quotaLimit = data.quota_limit;
			}

			// Process notes with detailed logging
			console.log('SendToVault: Starting note processing...');
			let processedCount = 0;
			let latestNoteDate: string | null = null;

			if (data.notes && Array.isArray(data.notes)) {
				for (const [index, note] of data.notes.entries()) {
					try {
						console.log(`SendToVault: Processing note ${index + 1}/${data.notes.length}:`, {
							id: note.id,
							title: note.title,
							created_iso: note.created_iso,
							markdown_preview: note.markdown ? note.markdown.substring(0, 100) + '...' : 'empty'
						});

						await this.saveNote(note);
						this.settings.importsThisMonth++;
						processedCount++;

						// Track latest note date
						if (!latestNoteDate || new Date(note.created_iso) > new Date(latestNoteDate)) {
							latestNoteDate = note.created_iso;
						}

						console.log(`SendToVault: Successfully processed note ${index + 1}: ${note.title}`);
					} catch (error) {
						console.error(`SendToVault: Failed to process note ${index + 1}:`, error);
						console.error('SendToVault: Failed note data:', note);
					}
				}
			} else {
				console.log('SendToVault: No notes to process (notes array is empty, null, or not an array)');
			}

			console.log(`SendToVault: Finished processing ${processedCount} notes`);

			// Update last sync time if we processed notes
			if (processedCount > 0 && latestNoteDate) {
				console.log('SendToVault: Updating lastSyncIso from', this.settings.lastSyncIso, 'to', latestNoteDate);
				this.settings.lastSyncIso = latestNoteDate;
			}

			await this.saveSettings();
			this.updateRibbonBadge();
			this.updateQuotaPanel();

			// Show paywall if over quota
			if (data.over_quota) {
				console.log('SendToVault: Over quota detected, showing paywall modal');
				new PaywallModal(this.app).open();
			}

			// Reset retry delay on success
			this.retryDelay = 2 * 60 * 1000;
			
			const pollDuration = Date.now() - pollStartTime;
			console.log(`SendToVault: Poll completed successfully in ${pollDuration}ms - processed ${processedCount} notes, quota: ${this.settings.quotaUsed}/${this.settings.quotaLimit}, imports this month: ${this.settings.importsThisMonth}`);
			
		} catch (error) {
			const pollDuration = Date.now() - pollStartTime;
			console.error(`SendToVault: Poll failed after ${pollDuration}ms:`, error);
			console.error('SendToVault: Full error details:', {
				message: error.message,
				stack: error.stack,
				name: error.name
			});
			
			// Exponential backoff
			const oldDelay = this.retryDelay;
			this.retryDelay = Math.min(this.retryDelay * 2, this.maxRetryDelay);
			console.log(`SendToVault: Retry delay increased from ${oldDelay}ms to ${this.retryDelay}ms`);
		}
	}

	private async saveNote(note: Note): Promise<void> {
		const inboxFolder = 'Inbox';
		
		// Ensure Inbox folder exists
		if (!this.app.vault.getAbstractFileByPath(inboxFolder)) {
			await this.app.vault.createFolder(inboxFolder);
		}

		// Sanitize filename
		const sanitizedTitle = note.title.replace(/[<>:"/\\|?*]/g, '_');
		const filename = `${inboxFolder}/${sanitizedTitle}.md`;
		
		try {
			const existingFile = this.app.vault.getAbstractFileByPath(filename);
			
			if (existingFile && existingFile.name === `${sanitizedTitle}.md`) {
				// Overwrite if user hasn't renamed the file
				await this.app.vault.modify(existingFile as TFile, note.markdown);
			} else {
				// Create new file
				const file = await this.app.vault.create(filename, note.markdown);
				
				// Auto-open if setting is enabled
				if (this.settings.autoOpenImported) {
					const leaf = this.app.workspace.getUnpinnedLeaf();
					await leaf.openFile(file);
				}
			}
			
			new Notice(`Imported: ${note.title}`);
		} catch (error) {
			console.error('Failed to save note:', error);
			new Notice(`Failed to save note: ${note.title}`);
		}
	}

	private updateRibbonBadge(): void {
		// Remove existing badge
		const existingBadge = this.ribbonIconEl.querySelector('.sendtovault-badge');
		if (existingBadge) {
			existingBadge.remove();
		}

		// Add new badge
		if (this.settings.importsThisMonth > 0) {
			const badge = document.createElement('div');
			badge.className = 'sendtovault-badge';
			badge.textContent = this.settings.importsThisMonth.toString();
			this.ribbonIconEl.appendChild(badge);
		}
	}

	private async toggleQuotaPanel(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_SENDTOVAULT);
		
		if (existing.length > 0) {
			// Close existing panel
			existing[0].detach();
		} else {
			// Open new panel
			const leaf = this.app.workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({
					type: VIEW_TYPE_SENDTOVAULT,
					active: true,
				});
				this.app.workspace.revealLeaf(leaf);
				this.updateQuotaPanel();
			}
		}
	}

	private updateQuotaPanel(): void {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_SENDTOVAULT);
		leaves.forEach((leaf: WorkspaceLeaf) => {
			const view = leaf.view as SendToVaultView;
			view.updateQuota(this.settings.quotaUsed, this.settings.quotaLimit, this.settings.importsThisMonth);
		});
	}

	async rotateAlias(): Promise<void> {
		await this.registerWithService(true);
	}

	async forceSync(): Promise<void> {
		console.log('SendToVault: Force sync triggered');
		new Notice('Syncing with SendToVault...');
		
		try {
			await this.poll();
			new Notice('Sync completed!');
		} catch (error) {
			console.error('SendToVault: Force sync failed:', error);
			new Notice('Sync failed. Please try again.');
		}
	}
}

class SendToVaultSettingTab extends PluginSettingTab {
	plugin: SendToVaultPlugin;

	constructor(app: App, plugin: SendToVaultPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Email Alias')
			.setDesc('Your unique email address for importing notes')
			.addText((text) => text
				.setPlaceholder('Not registered')
				.setValue(this.plugin.settings.alias)
				.setDisabled(true))
			.addButton((button) => button
				.setButtonText('Rotate')
				.setTooltip('Generate a new email alias')
				.onClick(async () => {
					await this.plugin.rotateAlias();
					this.display(); // Refresh the settings
				}));

		new Setting(containerEl)
			.setName('Auto-open imported notes')
			.setDesc('Automatically open new notes when they are imported')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.autoOpenImported)
				.onChange(async (value: boolean) => {
					this.plugin.settings.autoOpenImported = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Quota Usage')
			.setDesc(`${this.plugin.settings.quotaUsed} / ${this.plugin.settings.quotaLimit} notes this month`)
			.addText((text) => text
				.setValue(`${this.plugin.settings.importsThisMonth} imports this month`)
				.setDisabled(true));
	}
}
