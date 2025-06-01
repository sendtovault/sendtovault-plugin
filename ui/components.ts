import { App, Modal, Notice, Component } from 'obsidian';

export interface RegistrationResponse {
	email_address: string;
	passkey: string;
	vault_id: string;
	created_at: string;
}

export class FirstRunModal extends Modal {
	private registrationData: RegistrationResponse;
	private onComplete: () => void;

	constructor(app: App, registrationData: RegistrationResponse, onComplete: () => void) {
		super(app);
		this.registrationData = registrationData;
		this.onComplete = onComplete;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		
		contentEl.createEl('h2', { text: 'Welcome to SendToVault!' });
		
		contentEl.createEl('p', { 
			text: 'Your email alias has been created. Send emails to this address to import notes into Obsidian:' 
		});
		
		const aliasContainer = contentEl.createDiv({ cls: 'sendtovault-alias-container' });
		aliasContainer.createEl('code', { 
			text: this.registrationData.email_address,
			cls: 'sendtovault-alias'
		});
		
		const copyButton = aliasContainer.createEl('button', { text: 'Copy' });
		copyButton.onclick = () => {
			navigator.clipboard.writeText(this.registrationData.email_address);
			new Notice('Email alias copied to clipboard!');
		};
		
		const testButton = contentEl.createEl('button', { 
			text: 'Send test email',
			cls: 'mod-cta'
		});
		testButton.onclick = () => {
			const subject = encodeURIComponent('Test from Obsidian');
			const body = encodeURIComponent('This is a test email to verify SendToVault integration.');
			window.open(`mailto:${this.registrationData.email_address}?subject=${subject}&body=${body}`);
		};
		
		const doneButton = contentEl.createEl('button', { 
			text: 'Done',
			cls: 'mod-cta'
		});
		doneButton.onclick = () => {
			this.close();
			this.onComplete();
		};
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

export class PaywallModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		
		contentEl.createEl('h2', { text: 'Quota Exceeded' });
		
		contentEl.createEl('p', { 
			text: 'You\'ve reached your monthly import limit. Upgrade to continue importing notes.' 
		});
		
		const upgradeButton = contentEl.createEl('button', { 
			text: 'Upgrade Now',
			cls: 'mod-cta'
		});
		upgradeButton.onclick = () => {
			window.open('https://sendtovault.com/pricing');
		};
		
		const laterButton = contentEl.createEl('button', { text: 'Later' });
		laterButton.onclick = () => {
			this.close();
		};
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

export class QuotaPanel extends Component {
	private containerEl: HTMLElement;
	private quotaUsed: number = 0;
	private quotaLimit: number = 100;
	private importsThisMonth: number = 0;
	private onSyncCallback: (() => Promise<void>) | undefined;

	constructor(containerEl: HTMLElement, onSyncCallback?: () => Promise<void>) {
		super();
		this.containerEl = containerEl;
		this.onSyncCallback = onSyncCallback;
	}

	onload() {
		this.render();
	}

	onunload() {
		this.containerEl.empty();
	}

	updateQuota(used: number, limit: number, importsThisMonth: number) {
		this.quotaUsed = used;
		this.quotaLimit = limit;
		this.importsThisMonth = importsThisMonth;
		this.render();
	}

	private render() {
		this.containerEl.empty();
		
		console.log('QuotaPanel: Rendering with onSyncCallback:', this.onSyncCallback ? 'present' : 'missing');
		
		this.containerEl.createEl('h3', { text: 'SendToVault Status' });
		
		// Imports this month
		const importsEl = this.containerEl.createDiv({ cls: 'sendtovault-imports' });
		importsEl.createEl('span', { text: 'Imports this month: ' });
		importsEl.createEl('strong', { text: this.importsThisMonth.toString() });
		
		// Sync button
		if (this.onSyncCallback) {
			console.log('QuotaPanel: Creating sync button');
			const syncButton = this.containerEl.createEl('button', { 
				text: 'Sync Now',
				cls: 'sendtovault-sync-button mod-cta'
			});
			console.log('QuotaPanel: Sync button created:', syncButton);
			syncButton.onclick = async () => {
				syncButton.disabled = true;
				syncButton.textContent = 'Syncing...';
				try {
					await this.onSyncCallback!();
				} finally {
					syncButton.disabled = false;
					syncButton.textContent = 'Sync Now';
				}
			};
		} else {
			console.log('QuotaPanel: No sync callback provided, skipping sync button');
		}
		
		// Quota bar
		const quotaContainer = this.containerEl.createDiv({ cls: 'sendtovault-quota' });
		quotaContainer.createEl('div', { text: 'Monthly Quota' });
		
		const quotaBar = quotaContainer.createDiv({ cls: 'sendtovault-quota-bar' });
		const quotaFill = quotaBar.createDiv({ cls: 'sendtovault-quota-fill' });
		
		const percentage = Math.min((this.quotaUsed / this.quotaLimit) * 100, 100);
		quotaFill.style.width = `${percentage}%`;
		
		if (percentage > 90) {
			quotaFill.addClass('sendtovault-quota-warning');
		}
		
		const quotaText = quotaContainer.createDiv({ 
			text: `${this.quotaUsed} / ${this.quotaLimit}`,
			cls: 'sendtovault-quota-text'
		});
	}
}