const path = require('path')
const fs = require('fs')
const util = require('util')
const exists = util.promisify(fs.access)
const writeFile = util.promisify(fs.writeFile)
const unlink = util.promisify(fs.unlink)
const readFileAsync = util.promisify(fs.readFile)
const readFile = (file) => readFileAsync(file, { encoding: 'utf8' })
const glob = util.promisify(require('glob'))
const minimatch = require('minimatch')
const diffObject = require('deep-object-diff')
const diff = require('diff')

const config = require('./config')
const notify = require('./notify.js')
const githubApi = require('./github-api')
const PackageManager = require('./package-manager')
const InputView = require('./input-view')
const DiffView = require('./diff-view')

const REMOVE_KEYS = [
	'sync-settings.gistId',
	'sync-settings.personalAccessToken',
	'sync-settings.hiddenSettings._lastBackupTime',
	// keep legacy keys in blacklist
	'sync-settings._analyticsUserId',
	'sync-settings._lastBackupHash',
	'sync-settings.hiddenSettings._lastBackupHash',
]

module.exports = class SyncSettings {
	constructor () {
		this.packageManager = new PackageManager()
		this.gist = githubApi.gists

		config.updateLegacyConfigSettings()

		if (atom.config.get('sync-settings.checkForUpdatedBackup')) {
			this.checkForUpdate(true)
		}
	}

	useBusySignal (busySignal) {
		notify.useBusySignal(busySignal)
	}

	disposeBusySignal () {
		notify.disposeBusySignal()
	}

	async checkForUpdate (autoCheck) {
		const signal = notify.signal('Sync-Settings: Checking backup...')
		let personalAccessToken
		let gistId
		try {
			personalAccessToken = config.getPersonalAccessToken()
			if (!personalAccessToken) {
				notify.invalidPersonalAccessToken(() => { this.checkForUpdate(autoCheck) })
				return
			}

			gistId = config.getGistId()
			if (!gistId) {
				notify.invalidGistId(() => { this.checkForUpdate(autoCheck) })
				return
			}

			const res = await this.gist.get(personalAccessToken, { gist_id: gistId })

			if (this.invalidRes(res, ['data', 'files'], ['data', 'history', 0, 'committed_at'])) {
				return
			}

			const backupData = await this.getBackupData(res.data.files)
			if (!backupData) {
				return
			}

			const localData = await this.getLocalData()
			if (!localData) {
				return
			}

			const diffData = await this.getDiffData(localData, backupData)
			if (!diffData) {
				return
			}

			if (diffData.settings || diffData.packages || diffData.files) {
				const lastBackupTime = config.getLastBackupTime(res)
				notify.newerBackup(autoCheck, lastBackupTime, res.data.history[0].committed_at)
				return
			}

			if (!autoCheck) {
				notify.success('Sync-Settings: Your settings are synchronized.', {
					detail: 'Last Backup: ' + new Date(config.getLastBackupTime(res, true)).toLocaleString(),
				})
			}
		} catch (err) {
			console.error('error checking backup:', err)
			const message = githubApi.errorMessage(err)
			if (message === 'Not Found') {
				notify.invalidGistId(() => { this.checkForUpdate(autoCheck) }, gistId)
			} else if (message === 'Bad credentials') {
				notify.invalidPersonalAccessToken(() => { this.checkForUpdate(autoCheck) }, personalAccessToken)
			} else {
				notify.error('Sync-Settings: Error checking backup', {
					dismissable: true,
					detail: message,
				})
				throw err
			}
		} finally {
			signal.dismiss()
		}
	}

	async backup () {
		const signal = notify.signal('Sync-Settings: Updating backup...')
		let personalAccessToken
		let gistId
		try {
			const localData = await this.getLocalData()
			if (!localData) {
				return
			}

			const files = {}
			if (localData.settings) {
				files['settings.json'] = { content: JSON.stringify(localData.settings, null, '\t') }
			}
			if (localData.packages) {
				files['packages.json'] = { content: JSON.stringify(localData.packages, null, '\t') }
			}
			if (localData.files) {
				for (const fileName in localData.files) {
					const file = localData.files[fileName]
					files[fileName] = { content: file.content }
				}
			}

			personalAccessToken = config.getPersonalAccessToken()
			if (!personalAccessToken) {
				notify.invalidPersonalAccessToken(() => { this.backup() })
				return
			}

			gistId = config.getGistId()
			if (!gistId) {
				notify.invalidGistId(() => { this.backup() })
				return
			}

			if (atom.config.get('sync-settings.removeUnfamiliarFiles')) {
				const res = await this.gist.get(personalAccessToken, { gist_id: gistId })

				if (this.invalidRes(res, ['data', 'files'], ['data', 'history', 0, 'committed_at'])) {
					return
				}

				const backupData = await this.getBackupData(res.data.files)
				if (!backupData) {
					return
				}

				const diffData = await this.getDiffData(localData, backupData)
				if (!diffData) {
					return
				}

				if (diffData.files && diffData.files.added) {
					for (const fileName in diffData.files.added) {
						files[fileName] = { filename: null }
					}
				}
			}

			const res = await this.gist.update(personalAccessToken, {
				gist_id: gistId,
				description: atom.config.get('sync-settings.gistDescription'),
				files,
			})

			if (this.invalidRes(res, ['data', 'html_url'], ['data', 'history', 0, 'committed_at'])) {
				return
			}

			atom.config.set('sync-settings.hiddenSettings._lastBackupTime', res.data.history[0].committed_at)
			notify.success(`
Sync-Settings: Your settings were successfully backed up.

[Click here to open your Gist.](${res.data.html_url})`.trim())
		} catch (err) {
			console.error('error backing up data: ' + err.message, err)
			const message = githubApi.errorMessage(err)
			if (message === 'Not Found') {
				notify.invalidGistId(() => { this.backup() }, gistId)
			} else if (message === 'Bad credentials') {
				notify.invalidPersonalAccessToken(() => { this.backup() }, personalAccessToken)
			} else {
				notify.error('Sync-Settings: Error backing up settings', {
					dismissable: true,
					detail: message,
				})
				throw err
			}
		} finally {
			signal.dismiss()
		}
	}

	async getLocalData () {
		const data = {
			settings: null,
			packages: null,
			files: {},
		}

		if (atom.config.get('sync-settings.syncSettings')) {
			data.settings = this.getFilteredSettings()
		}
		if (atom.config.get('sync-settings.syncPackages') || atom.config.get('sync-settings.syncThemes')) {
			data.packages = this.getPackages()
		}
		const removeUnfamiliarFiles = atom.config.get('sync-settings.removeUnfamiliarFiles')
		if (atom.config.get('sync-settings.syncKeymap')) {
			const filePath = atom.keymaps.getUserKeymapPath()
			const content = await this.fileContent(filePath, removeUnfamiliarFiles ? null : '# keymap file (not found)')
			if (content) {
				const fileName = path.basename(filePath)
				data.files[fileName] = {
					path: filePath,
					content,
				}
			}
		}
		if (atom.config.get('sync-settings.syncStyles')) {
			const filePath = atom.styles.getUserStyleSheetPath()
			const content = await this.fileContent(filePath, removeUnfamiliarFiles ? null : '// styles file (not found)')
			if (content) {
				const fileName = path.basename(filePath)
				data.files[fileName] = {
					path: filePath,
					content,
				}
			}
		}
		if (atom.config.get('sync-settings.syncInit')) {
			const filePath = atom.getUserInitScriptPath()
			const content = await this.fileContent(filePath, removeUnfamiliarFiles ? null : '# initialization file (not found)')
			if (content) {
				const fileName = path.basename(filePath)
				data.files[fileName] = {
					path: filePath,
					content,
				}
			}
		}
		if (atom.config.get('sync-settings.syncSnippets')) {
			const filePath = await this.getSnippetsPath()
			const content = await this.fileContent(filePath, removeUnfamiliarFiles ? null : '# snippets file (not found)')
			if (content) {
				const fileName = path.basename(filePath)
				data.files[fileName] = {
					path: filePath,
					content,
				}
			}
		}

		const extraFiles = atom.config.get('sync-settings.extraFiles') || []
		for (const file of extraFiles) {
			if (!await this.addExtraFile(data.files, file, removeUnfamiliarFiles)) {
				return
			}
		}

		const extraFilesGlob = atom.config.get('sync-settings.extraFilesGlob') || []
		const ignoreFilesGlob = atom.config.get('sync-settings.ignoreFilesGlob') || []
		if (extraFilesGlob.length > 0) {
			for (const extraGlob of extraFilesGlob) {
				const extra = await glob(extraGlob, {
					cwd: atom.getConfigDirPath(),
					nodir: true,
					dot: true,
					ignore: ignoreFilesGlob,
				})

				for (const file of extra) {
					if (!await this.addExtraFile(data.files, file, removeUnfamiliarFiles)) {
						return
					}
				}
			}
		}

		if (Object.keys(data.files).length > 0) {
			data.files = this.sortObject(data.files)
		} else {
			data.files = null
		}

		return data
	}

	sortObject (obj, sortFn = ([ak, av], [bk, bv]) => ak.localeCompare(bk)) {
		return Object.entries(obj)
			.sort(sortFn)
			.reduce((newObj, [k, v]) => {
				newObj[k] = v
				return newObj
			}, {})
	}

	filterObject (obj, filterFn = ([k, v]) => v) {
		return Object.entries(obj)
			.filter(filterFn)
			.reduce((newObj, [k, v]) => {
				newObj[k] = v
				return newObj
			}, {})
	}

	async getSnippetsPath () {
		const jsonPath = path.resolve(atom.getConfigDirPath(), 'snippets.json')
		try {
			if (await exists(jsonPath)) {
				return jsonPath
			}
		} catch (ex) {}

		return path.resolve(atom.getConfigDirPath(), 'snippets.cson')
	}

	async addExtraFile (files, file, removeUnfamiliarFiles) {
		const fileName = file.replace(/\//g, '\\')
		if (fileName in files) {
			// already saved
			return true
		}
		if (file === 'config.cson' && atom.config.get('sync-settings.personalAccessToken') && atom.config.get('sync-settings.hiddenSettings._warnBackupConfig')) {
			notify.warnBackupConfig()
			return false
		}
		const ext = file.slice(file.lastIndexOf('.')).toLowerCase()
		let cmtstart = '#'
		let cmtend = ''
		if (['.less', '.scss', '.js'].includes(ext)) {
			cmtstart = '//'
		}
		if (['.css'].includes(ext)) {
			cmtstart = '/*'
			cmtend = '*/'
		}
		const filePath = path.resolve(atom.getConfigDirPath(), file)
		const content = await this.fileContent(filePath, removeUnfamiliarFiles ? null : `${cmtstart} ${file} (not found) ${cmtend}`)
		if (content) {
			files[fileName] = {
				path: filePath,
				content,
			}
		}
		return true
	}

	async viewBackup () {
		const { shell } = require('electron')
		const gistId = config.getGistId()
		if (!gistId) {
			notify.invalidGistId(() => { this.viewBackup() })
			return
		}
		shell.openExternal(`https://gist.github.com/${gistId}`)
	}

	async viewDiff () {
		if (!this.diffView) {
			this.diffView = new DiffView(this)
		}
		await atom.workspace.open(this.diffView)
		this.diffView.refresh()
	}

	getPackages () {
		const syncPackages = atom.config.get('sync-settings.syncPackages')
		const syncThemes = atom.config.get('sync-settings.syncThemes')
		const onlySyncCommunityPackages = atom.config.get('sync-settings.onlySyncCommunityPackages')
		const packages = {}
		const pkgMetadata = this.getAvailablePackageMetadataWithoutDuplicates()
		for (const pkgName in pkgMetadata) {
			const metadata = pkgMetadata[pkgName]
			const { name, version, theme, apmInstallSource } = metadata
			if ((syncThemes && theme) || (syncPackages && !theme)) {
				if (!onlySyncCommunityPackages || !atom.packages.isBundledPackage(name)) {
					const data = { version }
					if (theme) {
						data.theme = theme
					}
					if (apmInstallSource) {
						data.apmInstallSource = apmInstallSource
					}
					packages[name] = data
				}
			}
		}

		return this.sortObject(packages)
	}

	getAvailablePackageMetadataWithoutDuplicates () {
		const path2metadata = {}
		const packageMetadata = atom.packages.getAvailablePackageMetadata()
		const iterable = atom.packages.getAvailablePackagePaths()
		for (let i = 0; i < iterable.length; i++) {
			const path2 = iterable[i]
			path2metadata[fs.realpathSync(path2)] = packageMetadata[i]
		}

		const packages = {}
		const pkgNames = atom.packages.getAvailablePackageNames()
		for (const pkgName of pkgNames) {
			const pkgPath = atom.packages.resolvePackagePath(pkgName)
			if (path2metadata[pkgPath]) {
				packages[pkgPath] = path2metadata[pkgPath]
			} else {
				console.error('could not correlate package name, path, and metadata')
			}
		}
		return packages
	}

	async restore () {
		const signal = notify.signal('Sync-Settings: Restoring backup...')
		let personalAccessToken
		let gistId
		try {
			personalAccessToken = config.getPersonalAccessToken()
			if (!personalAccessToken) {
				notify.invalidPersonalAccessToken(() => { this.restore() })
				return
			}

			gistId = config.getGistId()
			if (!gistId) {
				notify.invalidGistId(() => { this.restore() })
				return
			}

			const res = await this.gist.get(personalAccessToken, { gist_id: gistId })

			if (this.invalidRes(res, ['data', 'files'], ['data', 'history', 0, 'committed_at'])) {
				notify.error('Sync-Settings: Error retrieving your settings.')
				return
			}

			const backupData = this.getBackupData(res.data.files)
			if (!backupData) {
				return
			}

			if (atom.config.get('sync-settings.removeUnfamiliarFiles')) {
				const localData = await this.getLocalData()
				if (!localData) {
					return
				}

				const diffData = await this.getDiffData(localData, backupData)
				if (!diffData) {
					return
				}

				if (diffData.files && diffData.files.deleted) {
					for (const fileName in diffData.files.deleted) {
						const file = localData.files[fileName]
						await unlink(file.path)
					}
				}
			}

			if (backupData.settings) {
				this.updateSettings(backupData.settings)
			}

			if (backupData.packages) {
				await this.installMissingPackages(backupData.packages)
				if (atom.config.get('sync-settings.removeObsoletePackages')) {
					await this.removeObsoletePackages(backupData.packages)
				}
			}

			if (backupData.files) {
				for (const fileName in backupData.files) {
					const file = backupData.files[fileName]
					await writeFile(file.path, file.content)
				}
			}

			atom.config.set('sync-settings.hiddenSettings._lastBackupTime', res.data.history[0].committed_at)

			notify.success('Sync-Settings: Your settings were successfully synchronized.')
		} catch (err) {
			console.error('error restoring backup:', err)
			const message = githubApi.errorMessage(err)
			if (message === 'Not Found') {
				notify.invalidGistId(() => { this.restore() }, gistId)
			} else if (message === 'Bad credentials') {
				notify.invalidPersonalAccessToken(() => { this.restore() }, personalAccessToken)
			} else {
				notify.error('Sync-Settings: Error restoring settings', {
					dismissable: true,
					detail: message,
				})
				throw err
			}
		} finally {
			signal.dismiss()
		}
	}

	fromLegacyPackages (packages) {
		// format legacy packages Array
		if (Array.isArray(packages)) {
			packages = packages.reduce((obj, pkg) => {
				const { name, ...rest } = pkg
				obj[name] = rest
				return obj
			}, {})
		}
		return packages
	}

	getBackupData (files) {
		const data = {
			settings: null,
			packages: null,
			files: {},
		}

		const configDirPath = atom.getConfigDirPath()
		for (let fileName in files) {
			try {
				const file = files[fileName]
				switch (fileName) {
					case 'settings.json':
						if (atom.config.get('sync-settings.syncSettings')) {
							data.settings = JSON.parse(file.content)
						}
						break

					case 'packages.json':
						if (atom.config.get('sync-settings.syncPackages') || atom.config.get('sync-settings.syncThemes')) {
							data.packages = this.fromLegacyPackages(JSON.parse(file.content))
							if (!atom.config.get('sync-settings.syncPackages')) {
								data.packages = this.filterObject(data.packages, ([k, v]) => v.theme)
							}
							if (!atom.config.get('sync-settings.syncThemes')) {
								data.packages = this.filterObject(data.packages, ([k, v]) => !v.theme)
							}
							if (atom.config.get('sync-settings.onlySyncCommunityPackages')) {
								data.packages = this.filterObject(data.packages, ([k, v]) => !atom.packages.isBundledPackage(k))
							}
						}
						break

					case 'keymap.cson':
					case 'keymap.json':
						if (atom.config.get('sync-settings.syncKeymap')) {
							data.files[fileName] = {
								path: atom.keymaps.getUserKeymapPath(),
								content: file.content,
							}
						}
						break

					case 'styles.css':
					case 'styles.less':
						if (atom.config.get('sync-settings.syncStyles')) {
							data.files[fileName] = {
								path: atom.styles.getUserStyleSheetPath(),
								content: file.content,
							}
						}
						break

					case 'init.coffee':
					case 'init.js':
						if (atom.config.get('sync-settings.syncInit')) {
							data.files[fileName] = {
								path: path.resolve(configDirPath, fileName),
								content: file.content,
							}
						}
						break

					case 'snippets.cson':
					case 'snippets.json':
						if (atom.config.get('sync-settings.syncSnippets')) {
							data.files[fileName] = {
								path: path.resolve(configDirPath, fileName),
								content: file.content,
							}
						}
						break

					default: {
						fileName = fileName.replace(/\\/g, '/')
						const filePath = path.resolve(configDirPath, fileName)
						let extraFiles = atom.config.get('sync-settings.extraFiles') || []
						extraFiles = extraFiles.map(f => f.replace(/\\/g, '/'))
						if (extraFiles.includes(fileName)) {
							data.files[fileName] = {
								path: filePath,
								content: file.content,
							}
						} else {
							const extraFilesGlob = atom.config.get('sync-settings.extraFilesGlob') || []
							const ignoreFilesGlob = atom.config.get('sync-settings.ignoreFilesGlob') || []
							const match = (g) => minimatch(fileName, g, { dot: true })
							if (extraFilesGlob.some(match) && !ignoreFilesGlob.some(match)) {
								data.files[fileName] = {
									path: filePath,
									content: file.content,
								}
							}
						}
					}
				}
			} catch (err) {
				notify.error(`Sync-Settings: Error parsing the file '${fileName}'. (${err})`)
				return
			}
		}

		if (Object.keys(data.files).length > 0) {
			data.files = this.sortObject(data.files)
		} else {
			data.files = null
		}

		return data
	}

	updateSettings (settings) {
		if (!('*' in settings)) {
			// backed up before v2.0.2
			settings = { '*': settings }
		}
		this.addFilteredSettings(settings)
		for (const scopeSelector in settings) {
			atom.config.set(null, settings[scopeSelector], { scopeSelector })
		}
	}

	addFilteredSettings (settings) {
		const { setValueAtKeyPath } = require('key-path-helpers')
		const blacklistedKeys = [
			...REMOVE_KEYS,
			...atom.config.get('sync-settings.blacklistedKeys') || [],
		]
		for (const blacklistedKey of blacklistedKeys) {
			const value = atom.config.get(blacklistedKey)
			if (typeof value !== 'undefined') {
				setValueAtKeyPath(settings['*'], blacklistedKey, value)
			}
		}

		return settings
	}

	getFilteredSettings () {
		const { deleteValueAtKeyPath } = require('key-path-helpers')
		// _.clone() doesn't deep clone thus we are using JSON parse trick
		const settings = JSON.parse(JSON.stringify({
			'*': atom.config.settings,
			...atom.config.scopedSettingsStore.propertiesForSource(atom.config.mainSource),
		}))
		const blacklistedKeys = [
			...REMOVE_KEYS,
			...atom.config.get('sync-settings.blacklistedKeys') || [],
		]
		for (const blacklistedKey of blacklistedKeys) {
			deleteValueAtKeyPath(settings['*'], blacklistedKey)
		}

		return settings
	}

	async removeObsoletePackages (packages) {
		const installedPackages = this.getPackages()
		const removePackages = Object.keys(installedPackages)
			.filter(i => !packages[i])
			.map(name => {
				return {
					name,
					...installedPackages[name],
				}
			})
		if (removePackages.length === 0) {
			console.info('Sync-Settings: no packages to remove')
			return
		}

		const total = removePackages.length
		const notifications = {}
		const succeeded = []
		const failed = []
		const removeNextPackage = async () => {
			if (removePackages.length > 0) {
				// start removing next package
				const pkg = removePackages.shift()
				const i = total - removePackages.length
				notifications[pkg.name] = notify.count(`Sync-Settings: removing ${pkg.name}`, i, total)

				try {
					await this.removePackage(pkg)
					succeeded.push(pkg.name)
				} catch (err) {
					failed.push(pkg.name)
					notify.warning(`Sync-Settings: failed to remove ${pkg.name}`)
				}

				notifications[pkg.name].dismiss()
				delete notifications[pkg.name]

				return removeNextPackage()
			} else if (Object.keys(notifications).length === 0) {
				// last package removed
				if (failed.length === 0) {
					notify.success(`Sync-Settings: finished removing ${succeeded.length} packages`)
				} else {
					failed.sort()
					const failedStr = failed.join(', ')
					notify.warning(`Sync-Settings: finished removing packages (${failed.length} failed: ${failedStr})`, { dismissable: true })
				}
			}
		}
		// start as many package removal in parallel as desired
		const concurrency = Math.min(removePackages.length, 8)
		const result = []
		for (let i = 0; i < concurrency; i++) {
			result.push(removeNextPackage())
		}
		await Promise.all(result)
	}

	async removePackage (pkg) {
		const type = pkg.theme ? 'theme' : 'package'
		console.info(`Removing ${type} ${pkg.name}...`)
		await new Promise((resolve, reject) => {
			this.packageManager.uninstall(pkg, (err) => {
				if (err) {
					console.error(
						`Removing ${type} ${pkg.name} failed`,
						err.stack ? err.stack : err,
						err.stderr,
					)
					reject(err)
				} else {
					console.info(`Removing ${type} ${pkg.name}`)
					resolve()
				}
			})
		})
	}

	async installMissingPackages (packages) {
		const availablePackages = this.getPackages()
		const missingPackages = Object.keys(packages)
			.filter(p => !availablePackages[p] || !p.apmInstallSource !== !availablePackages[p].apmInstallSource)
			.map(name => {
				return {
					name,
					...packages[name],
				}
			})
		if (missingPackages.length === 0) {
			console.info('Sync-Settings: no packages to install')
			return
		}

		const total = missingPackages.length
		const notifications = {}
		const succeeded = []
		const failed = []
		const installNextPackage = async () => {
			if (missingPackages.length > 0) {
				// start installing next package
				const pkg = missingPackages.shift()
				const name = pkg.name
				const i = total - missingPackages.length
				notifications[name] = notify.count(`Sync-Settings: installing ${name}`, i, total)

				try {
					await this.installPackage(pkg)
					succeeded.push(name)
				} catch (err) {
					failed.push(name)
					notify.warning(`Sync-Settings: failed to install ${name}`)
				}

				notifications[name].dismiss()
				delete notifications[name]

				return installNextPackage()
			} else if (Object.keys(notifications).length === 0) {
				// last package installation finished
				if (failed.length === 0) {
					notify.success(`Sync-Settings: finished installing ${succeeded.length} packages`)
				} else {
					failed.sort()
					const failedStr = failed.join(', ')
					notify.warning(`Sync-Settings: finished installing packages (${failed.length} failed: ${failedStr})`, { dismissable: true })
				}
			}
		}
		// start as many package installations in parallel as desired
		const concurrency = Math.min(missingPackages.length, 8)
		const result = []
		for (let i = 0; i < concurrency; i++) {
			result.push(installNextPackage())
		}
		await Promise.all(result)
	}

	async installPackage (pkg) {
		const type = pkg.theme ? 'theme' : 'package'
		const name = pkg.name
		console.info(`Installing ${type} ${name}...`)
		await new Promise((resolve, reject) => {
			if (atom.config.get('sync-settings.installLatestVersion')) {
				pkg.version = null
			} else if (pkg.apmInstallSource) {
				pkg.name = pkg.apmInstallSource.source
				pkg.version = null
			}
			this.packageManager.install(pkg, (err) => {
				if (err) {
					console.error(
						`Installing ${type} ${name} failed`,
						err.stack ? err.stack : err,
						err.stderr,
					)
					reject(err)
				} else {
					console.info(`Installed ${type} ${name}`)
					resolve()
				}
			})
		})
	}

	async fileContent (filePath, nullString) {
		try {
			const content = await readFile(filePath)
			return content.trim() !== '' ? content : (nullString || null)
		} catch (err) {
			console.error(`Error reading file ${filePath}. Probably doesn't exist.`, err)
			return nullString || null
		}
	}

	async inputForkGistId () {
		const inputView = new InputView({
			title: 'Fork Gist',
			description: 'Enter the Gist ID that you want to fork.',
			placeholder: 'Gist ID to Fork',
			value: config.getGistId(),
		})
		const forkId = await inputView.getInput()
		if (forkId) {
			return this.forkGistId(forkId)
		}
	}

	async forkGistId (forkId) {
		const signal = notify.signal('Sync-Settings: Forking backup...')

		let personalAccessToken
		try {
			personalAccessToken = config.getPersonalAccessToken()
			if (!personalAccessToken) {
				notify.invalidPersonalAccessToken(() => { this.forkGistId(forkId) })
				return
			}

			const res = await this.gist.fork(personalAccessToken, { gist_id: forkId })

			if (this.invalidRes(res, ['data', 'id'])) {
				return
			}
			const gistId = res.data.id
			atom.config.set('sync-settings.gistId', gistId)
			notify.success('Sync-Settings: Forked successfully', {
				description: `Your new Gist has been created with id [\`${gistId}\`](https://gist.github.com/${gistId}) which has been saved to your config file.`,
			})
		} catch (err) {
			console.error('error forking backup:', err)
			const message = githubApi.errorMessage(err)
			if (message === 'Not Found') {
				notify.invalidGistId((gistId) => { this.forkGistId(gistId) }, forkId)
			} else if (message === 'Bad credentials') {
				notify.invalidPersonalAccessToken(() => { this.forkGistId(forkId) }, personalAccessToken)
			} else {
				notify.error('Sync-Settings: Error forking a backup', {
					dismissable: true,
					detail: message,
				})
				throw err
			}
		} finally {
			signal.dismiss()
		}
	}

	getDiffData (localData, backupData) {
		const data = {
			settings: null,
			packages: null,
			files: null,
		}

		if (backupData.settings && localData.settings) {
			const settings = diffObject.detailedDiff(localData.settings, backupData.settings)
			for (const prop in settings) {
				if (Object.keys(settings[prop]).length === 0) {
					delete settings[prop]
				}
			}
			if (Object.keys(settings).length > 0) {
				data.settings = {}
				if (settings.added) {
					data.settings.added = this.settingsToKeyPaths(settings.added)
				}
				if (settings.updated) {
					data.settings.updated = this.settingsToKeyPaths(settings.updated, '', true)
				}
				if (settings.deleted) {
					data.settings.deleted = this.settingsToKeyPaths(settings.deleted)
				}
			}
		} else if (backupData.settings) {
			data.settings = { added: this.settingsToKeyPaths(backupData.settings) }
		} else if (localData.settings) {
			data.settings = { deleted: this.settingsToKeyPaths(localData.settings) }
		}

		if (backupData.packages && localData.packages) {
			const packages = diffObject.detailedDiff(localData.packages, backupData.packages)
			for (const prop in packages) {
				if (Object.keys(packages[prop]).length === 0) {
					delete packages[prop]
				}
			}
			if (Object.keys(packages).length > 0) {
				data.packages = {}
				if (packages.added) {
					data.packages.added = packages.added
				}
				if (packages.updated) {
					data.packages.updated = {}
					for (const name in packages.updated) {
						data.packages.updated[name] = {
							backup: backupData.packages[name],
							local: localData.packages[name],
						}
					}
				}
				if (packages.deleted) {
					data.packages.deleted = {}
					for (const name in packages.deleted) {
						data.packages.deleted[name] = localData.packages[name]
					}
				}
			}
		} else if (backupData.packages) {
			data.packages = { added: backupData.packages }
		} else if (localData.packages) {
			data.packages = { deleted: localData.packages }
		}

		if (localData.files || backupData.files) {
			const fileNames = [...new Set([
				...Object.keys(localData.files || {}),
				...Object.keys(backupData.files || {}),
			])].sort()

			for (const fileName of fileNames) {
				const backupFile = backupData.files ? backupData.files[fileName] : null
				const localFile = localData.files ? localData.files[fileName] : null
				if (backupFile && localFile) {
					if (localFile.content !== backupFile.content) {
						const updated = {
							...backupFile,
							content: diff.createTwoFilesPatch('local', 'backup', localFile.content, backupFile.content, undefined, undefined, { context: 2 }),
						}
						this.addDiffFile(data, 'updated', fileName, updated)
					}
				} else if (backupFile) {
					this.addDiffFile(data, 'added', fileName, backupFile)
				} else if (localFile) {
					this.addDiffFile(data, 'deleted', fileName, localFile)
				}
			}
		}

		return data
	}

	settingsToKeyPaths (obj, prefix = '', getOldValue = false) {
		const settings = []
		for (const prop in obj) {
			const nextPrefix = (prefix ? `${prefix}.${prop}` : (prop === '*' ? '' : prop))
			let item = obj[prop]
			if (item == null) {
				item = atom.config.get(nextPrefix)
			}
			if (typeof item === 'object' && !Array.isArray(item)) {
				settings.push(...this.settingsToKeyPaths(item, nextPrefix, getOldValue))
			} else {
				const diffObj = {
					keyPath: nextPrefix,
					value: item,
				}
				if (getOldValue) {
					diffObj.oldValue = atom.config.get(nextPrefix)
				}
				settings.push(diffObj)
			}
		}
		return settings
	}

	addDiffFile (diffData, method, fileName, fileObj) {
		if (!diffData.files) {
			diffData.files = {}
		}
		if (!diffData.files[method]) {
			diffData.files[method] = {}
		}
		diffData.files[method][fileName] = fileObj
	}

	invalidRes (res, ...paths) {
		function error () {
			console.error('could not interpret result:', res)
			notify.error('Sync-Settings: Error retrieving your settings.')
			return true
		}

		if (!res) {
			return error()
		}
		for (let props of paths) {
			if (!Array.isArray(props)) {
				props = [props]
			}
			let obj = res
			while (props.length > 0) {
				obj = obj[props.shift()]
				if (!obj) {
					return error()
				}
			}
		}
		return false
	}
}