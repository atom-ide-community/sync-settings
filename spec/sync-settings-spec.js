const SyncSettings = require('../lib/sync-settings')
const fs = require('fs')
const util = require('util')
const writeFile = util.promisify(fs.writeFile)
const unlink = util.promisify(fs.unlink)
const path = require('path')
const os = require('os')
// Use the command `window:run-package-specs` (cmd-alt-ctrl-p) to run specs.
//
// To run a specific `it` or `describe` block add an `f` to the front (e.g. `fit`
// or `fdescribe`). Remove the `f` to unfocus the block.

describe('SyncSettings', () => {
	describe('low-level', () => {
		it('should activate and destroy without error', async () => {
			await atom.packages.activatePackage('sync-settings')
			// wait for package to activate
			await new Promise(resolve => setImmediate(resolve))
			await atom.packages.deactivatePackage('sync-settings')
		})

		describe('::fileContent', () => {
			const tmpPath = path.join(os.tmpdir(), 'atom-sync-settings.tmp')

			it('returns null for not existing file', async () => {
				expect(await SyncSettings.fileContent(tmpPath)).toBeNull()
			})

			it('returns null for empty file', async () => {
				await writeFile(tmpPath, '')
				try {
					expect(await SyncSettings.fileContent(tmpPath)).toBeNull()
				} finally {
					await unlink(tmpPath)
				}
			})

			it('returns content of existing file', async () => {
				const text = 'alabala portocala'
				await writeFile(tmpPath, text)
				try {
					expect(await SyncSettings.fileContent(tmpPath)).toEqual(text)
				} finally {
					await unlink(tmpPath)
				}
			})
		})
	})

	describe('high-level', () => {
		beforeEach(async () => {
			await atom.packages.activatePackage('sync-settings')
			// wait for package to activate
			await new Promise(resolve => setImmediate(resolve))

			if (!process.env.GITHUB_TOKEN) {
				console.error('GITHUB_TOKEN does not exist. Mocking API calls.')
				const CreateClient = require('./create-client-mock')
				spyOn(SyncSettings, 'createClient').and.returnValue(new CreateClient())
			}

			const token = process.env.GITHUB_TOKEN || atom.config.get('sync-settings.personalAccessToken')
			atom.config.set('sync-settings.personalAccessToken', token)

			const gistSettings = {
				public: false,
				description: 'Test gist by Sync Settings for Atom https://github.com/atom-community/sync-settings',
				files: { README: { content: '# Generated by Sync Settings for Atom https://github.com/atom-community/sync-settings' } },
			}

			const res = await SyncSettings.createClient().gists.create(gistSettings)

			console.log(`Using Gist ${res.data.id}`)
			atom.config.set('sync-settings.gistId', res.data.id)
		})

		afterEach(async () => {
			await SyncSettings.createClient().gists.delete({ gist_id: SyncSettings.getGistId() })
			await await atom.packages.deactivatePackage('sync-settings')
		})

		describe('::backup', () => {
			it('back up the settings', async () => {
				atom.config.set('sync-settings.syncSettings', true)
				await SyncSettings.backup()
				const res = await SyncSettings.getGist()

				expect(res.data.files['settings.json']).toBeDefined()
			})

			it("don't back up the settings", async () => {
				atom.config.set('sync-settings.syncSettings', false)
				await SyncSettings.backup()
				const res = await SyncSettings.getGist()

				expect(res.data.files['settings.json']).not.toBeDefined()
			})

			it('back up the installed packages list', async () => {
				atom.config.set('sync-settings.syncPackages', true)
				await SyncSettings.backup()
				const res = await SyncSettings.getGist()

				expect(res.data.files['packages.json']).toBeDefined()
			})

			it("don't back up the installed packages list", async () => {
				atom.config.set('sync-settings.syncPackages', false)
				await SyncSettings.backup()
				const res = await SyncSettings.getGist()

				expect(res.data.files['packages.json']).not.toBeDefined()
			})

			it('back up the user keymaps', async () => {
				atom.config.set('sync-settings.syncKeymap', true)
				await SyncSettings.backup()
				const res = await SyncSettings.getGist()

				expect(res.data.files['keymap.cson']).toBeDefined()
			})

			it("don't back up the user keymaps", async () => {
				atom.config.set('sync-settings.syncKeymap', false)
				await SyncSettings.backup()
				const res = await SyncSettings.getGist()

				expect(res.data.files['keymap.cson']).not.toBeDefined()
			})

			it('back up the user styles', async () => {
				atom.config.set('sync-settings.syncStyles', true)
				await SyncSettings.backup()
				const res = await SyncSettings.getGist()

				expect(res.data.files['styles.less']).toBeDefined()
			})

			it("don't back up the user styles", async () => {
				atom.config.set('sync-settings.syncStyles', false)
				await SyncSettings.backup()
				const res = await SyncSettings.getGist()

				expect(res.data.files['styles.less']).not.toBeDefined()
			})

			it('back up the user init script file', async () => {
				atom.config.set('sync-settings.syncInit', true)
				await SyncSettings.backup()
				const res = await SyncSettings.getGist()

				expect(res.data.files[path.basename(atom.getUserInitScriptPath())]).toBeDefined()
			})

			it("don't back up the user init script file", async () => {
				atom.config.set('sync-settings.syncInit', false)
				await SyncSettings.backup()
				const res = await SyncSettings.getGist()

				expect(res.data.files[path.basename(atom.getUserInitScriptPath())]).not.toBeDefined()
			})

			it('back up the user snippets', async () => {
				atom.config.set('sync-settings.syncSnippets', true)
				await SyncSettings.backup()
				const res = await SyncSettings.getGist()

				expect(res.data.files['snippets.cson']).toBeDefined()
			})

			it("don't back up the user snippets", async () => {
				atom.config.set('sync-settings.syncSnippets', false)
				await SyncSettings.backup()
				const res = await SyncSettings.getGist()

				expect(res.data.files['snippets.cson']).not.toBeDefined()
			})

			it('back up the files defined in config.extraFiles', async () => {
				atom.config.set('sync-settings.extraFiles', ['test.tmp', 'test2.tmp'])
				await SyncSettings.backup()
				const res = await SyncSettings.getGist()
				atom.config.get('sync-settings.extraFiles').forEach(file => {
					expect(res.data.files[file]).toBeDefined()
				})
			})

			it("don't back up extra files defined in config.extraFiles", async () => {
				atom.config.set('sync-settings.extraFiles', undefined)
				await SyncSettings.backup()
				const res = await SyncSettings.getGist()

				expect(Object.keys(res.data.files).length).toBe(7)
			})
		})

		describe('::restore', () => {
			it('updates settings', async () => {
				atom.config.set('sync-settings.syncSettings', true)
				atom.config.set('some-dummy', true)
				await SyncSettings.backup()
				atom.config.set('some-dummy', false)
				await SyncSettings.restore()

				expect(atom.config.get('some-dummy')).toBeTruthy()
			})

			it("doesn't updates settings", async () => {
				atom.config.set('sync-settings.syncSettings', false)
				atom.config.set('some-dummy', true)
				await SyncSettings.backup()
				await SyncSettings.restore()

				expect(atom.config.get('some-dummy')).toBeTruthy()
			})

			it('overrides keymap.cson', async () => {
				atom.config.set('sync-settings.syncKeymap', true)
				let original = await SyncSettings.fileContent(atom.keymaps.getUserKeymapPath())
				if (!original) {
					original = '# keymap file (not found)'
				}

				try {
					await SyncSettings.backup()
					await writeFile(atom.keymaps.getUserKeymapPath(), `${original}\n# modified by sync setting spec`)
					await SyncSettings.restore()
					const content = await SyncSettings.fileContent(atom.keymaps.getUserKeymapPath())

					expect(content).toEqual(original)
				} finally {
					await writeFile(atom.keymaps.getUserKeymapPath(), original)
				}
			})

			it('restores all other files in the gist as well', async () => {
				const files = ['test.tmp', 'test2.tmp']
				atom.config.set('sync-settings.extraFiles', files)
				try {
					await SyncSettings.backup()
					await SyncSettings.restore()

					for (const file of files) {
						expect(fs.existsSync(`${atom.getConfigDirPath()}/${file}`)).toBe(true)
						expect(await SyncSettings.fileContent(`${atom.getConfigDirPath()}/${file}`)).toBe(`# ${file} (not found) `)
					}
				} finally {
					for (const file of files) {
						await unlink(`${atom.getConfigDirPath()}/${file}`)
					}
				}
			})

			it('skips the restore due to invalid json', async () => {
				atom.config.set('sync-settings.syncSettings', true)
				atom.config.set('sync-settings.extraFiles', ['packages.json'])
				atom.config.set('some-dummy', false)
				await SyncSettings.backup()
				atom.config.set('some-dummy', true)
				atom.notifications.clear()
				await SyncSettings.restore()

				expect(atom.notifications.getNotifications().length).toEqual(1)
				expect(atom.notifications.getNotifications()[0].getType()).toBe('error')
				// the value should not be restored
				// since the restore valid to parse the input as valid json
				expect(atom.config.get('some-dummy')).toBeTruthy()
			})

			it('restores keys with dots', async () => {
				atom.config.set('sync-settings.syncSettings', true)
				atom.config.set('some\\.key', ['one', 'two'])
				await SyncSettings.backup()
				atom.config.set('some\\.key', ['two'])
				await SyncSettings.restore()

				expect(atom.config.get('some\\.key').length).toBe(2)
				expect(atom.config.get('some\\.key')[0]).toBe('one')
				expect(atom.config.get('some\\.key')[1]).toBe('two')
			})
		})

		describe('::check for update', () => {
			beforeEach(() => {
				atom.config.unset('sync-settings._lastBackupHash')
			})

			it('updates last hash on backup', async () => {
				await SyncSettings.backup()

				expect(atom.config.get('sync-settings._lastBackupHash')).toBeDefined()
			})

			it('updates last hash on restore', async () => {
				await SyncSettings.restore()

				expect(atom.config.get('sync-settings._lastBackupHash')).toBeDefined()
			})

			describe('::notification', () => {
				beforeEach(() => {
					atom.notifications.clear()
				})

				it('displays on newer backup', async () => {
					await SyncSettings.checkForUpdate()

					expect(atom.notifications.getNotifications().length).toBe(1)
					expect(atom.notifications.getNotifications()[0].getType()).toBe('warning')
				})

				it('ignores on up-to-date backup', async () => {
					await SyncSettings.backup()
					atom.notifications.clear()
					await SyncSettings.checkForUpdate()

					expect(atom.notifications.getNotifications().length).toBe(1)
					expect(atom.notifications.getNotifications()[0].getType()).toBe('success')
				})
			})
		})
	})
})
