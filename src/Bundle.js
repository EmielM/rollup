import { timeStart, timeEnd } from './utils/flushTime.js';
import { decode } from 'sourcemap-codec';
import { Bundle as MagicStringBundle } from 'magic-string';
import first from './utils/first.js';
import { find } from './utils/array.js';
import { blank, forOwn, keys } from './utils/object.js';
import Module from './Module.js';
import ExternalModule from './ExternalModule.js';
import finalisers from './finalisers/index.js';
import ensureArray from './utils/ensureArray.js';
import { load, makeOnwarn, resolveId } from './utils/defaults.js';
import getExportMode from './utils/getExportMode.js';
import getIndentString from './utils/getIndentString.js';
import { mapSequence } from './utils/promise.js';
import transform from './utils/transform.js';
import transformBundle from './utils/transformBundle.js';
import collapseSourcemaps from './utils/collapseSourcemaps.js';
import SOURCEMAPPING_URL from './utils/sourceMappingURL.js';
import callIfFunction from './utils/callIfFunction.js';
import { dirname, isRelative, isAbsolute, normalize, relative, resolve } from './utils/path.js';
import BundleScope from './ast/scopes/BundleScope.js';

export default class Bundle {
	constructor ( options ) {
		this.cachedModules = new Map();
		if ( options.cache ) {
			options.cache.modules.forEach( module => {
				this.cachedModules.set( module.id, module );
			});
		}

		this.plugins = ensureArray( options.plugins );

		options = this.plugins.reduce( ( acc, plugin ) => {
			if ( plugin.options ) return plugin.options( acc ) || acc;
			return acc;
		}, options);

		this.entry = options.entry;
		this.entryId = null;
		this.entryModule = null;

		this.treeshake = options.treeshake !== false;

		this.resolveId = first(
			[ id => this.isExternal( id ) ? false : null ]
				.concat( this.plugins.map( plugin => plugin.resolveId ).filter( Boolean ) )
				.concat( resolveId )
		);

		const loaders = this.plugins
			.map( plugin => plugin.load )
			.filter( Boolean );
		this.hasLoaders = loaders.length !== 0;
		this.load = first( loaders.concat( load ) );

		this.getPath = typeof options.paths === 'function' ?
			( id => options.paths( id ) || this.getPathRelativeToEntryDirname( id ) ) :
			options.paths ?
				( id => options.paths.hasOwnProperty( id ) ? options.paths[ id ] : this.getPathRelativeToEntryDirname( id ) ) :
				id => this.getPathRelativeToEntryDirname( id );

		this.scope = new BundleScope();
		// TODO strictly speaking, this only applies with non-ES6, non-default-only bundles
		[ 'module', 'exports', '_interopDefault' ].forEach( name => {
			this.scope.findDeclaration( name ); // creates global declaration as side-effect
		});

		this.moduleById = new Map();
		this.modules = [];
		this.externalModules = [];

		this.context = String( options.context );

		if ( typeof options.moduleContext === 'function' ) {
			this.getModuleContext = id => options.moduleContext( id ) || this.context;
		} else if ( typeof options.moduleContext === 'object' ) {
			const moduleContext = new Map();
			Object.keys( options.moduleContext ).forEach( key => {
				moduleContext.set( resolve( key ), options.moduleContext[ key ] );
			});
			this.getModuleContext = id => moduleContext.get( id ) || this.context;
		} else {
			this.getModuleContext = () => this.context;
		}

		if ( typeof options.external === 'function' ) {
			this.isExternal = options.external;
		} else {
			const ids = ensureArray( options.external );
			this.isExternal = id => ids.indexOf( id ) !== -1;
		}

		this.onwarn = options.onwarn || makeOnwarn();

		this.varOrConst = options.preferConst ? 'const' : 'var';
		this.legacy = options.legacy;
		this.acornOptions = options.acorn || {};

		this.dependentExpressions = [];
	}

	build () {
		// Phase 1 – discovery. We load the entry module and find which
		// modules it imports, and import those, until we have all
		// of the entry module's dependencies
		return this.resolveId( this.entry, undefined )
			.then( id => {
				if ( id == null ) throw new Error( `Could not resolve entry (${this.entry})` );
				this.entryId = id;
				return this.fetchModule( id, undefined );
			})
			.then( entryModule => {
				this.entryModule = entryModule;

				// Phase 2 – binding. We link references to their declarations
				// to generate a complete picture of the bundle

				timeStart( 'phase 2' );

				this.modules.forEach( module => module.bindImportSpecifiers() );
				this.modules.forEach( module => module.bindReferences() );

				timeEnd( 'phase 2' );

				// Phase 3 – marking. We 'run' each statement to see which ones
				// need to be included in the generated bundle

				timeStart( 'phase 3' );

				// mark all export statements
				entryModule.getExports().forEach( name => {
					const declaration = entryModule.traceExport( name );

					declaration.exportName = name;
					declaration.activate();

					if ( declaration.isNamespace ) {
						declaration.needsNamespaceBlock = true;
					}
				});

				// mark statements that should appear in the bundle
				if ( this.treeshake ) {
					this.modules.forEach( module => {
						module.run();
					});

					let settled = false;
					while ( !settled ) {
						settled = true;

						let i = this.dependentExpressions.length;
						while ( i-- ) {
							const expression = this.dependentExpressions[i];

							let statement = expression;
							while ( statement.parent && !/Function/.test( statement.parent.type ) ) statement = statement.parent;

							if ( !statement || statement.ran ) {
								this.dependentExpressions.splice( i, 1 );
							} else if ( expression.isUsedByBundle() ) {
								settled = false;
								statement.run( statement.findScope() );
								this.dependentExpressions.splice( i, 1 );
							}
						}
					}
				}

				timeEnd( 'phase 3' );

				// Phase 4 – final preparation. We order the modules with an
				// enhanced topological sort that accounts for cycles, then
				// ensure that names are deconflicted throughout the bundle

				timeStart( 'phase 4' );

				this.orderedModules = this.sort();
				this.deconflict();

				timeEnd( 'phase 4' );
			});
	}

	deconflict () {
		const used = blank();

		// ensure no conflicts with globals
		keys( this.scope.declarations ).forEach( name => used[ name ] = 1 );

		function getSafeName ( name ) {
			while ( used[ name ] ) {
				name += `$${used[name]++}`;
			}

			used[ name ] = 1;
			return name;
		}

		const toDeshadow = new Map();

		this.externalModules.forEach( module => {
			const safeName = getSafeName( module.name );
			toDeshadow.set( safeName, true );
			module.name = safeName;

			// ensure we don't shadow named external imports, if
			// we're creating an ES6 bundle
			forOwn( module.declarations, ( declaration, name ) => {
				const safeName = getSafeName( name );
				toDeshadow.set( safeName, true );
				declaration.setSafeName( safeName );
			});
		});

		this.modules.forEach( module => {
			forOwn( module.scope.declarations, ( declaration ) => {
				if ( declaration.isDefault && declaration.declaration.id ) {
					return;
				}

				declaration.name = getSafeName( declaration.name );
			});

			// deconflict reified namespaces
			const namespace = module.namespace();
			if ( namespace.needsNamespaceBlock ) {
				namespace.name = getSafeName( namespace.name );
			}
		});

		this.scope.deshadow( toDeshadow );
	}

	fetchModule ( id, importer ) {
		// short-circuit cycles
		if ( this.moduleById.has( id ) ) return null;
		this.moduleById.set( id, null );

		return this.load( id )
			.catch( err => {
				let msg = `Could not load ${id}`;
				if ( importer ) msg += ` (imported by ${importer})`;

				msg += `: ${err.message}`;
				throw new Error( msg );
			})
			.then( source => {
				if ( typeof source === 'string' ) return source;
				if ( source && typeof source === 'object' && source.code ) return source;

				throw new Error( `Error loading ${id}: load hook should return a string, a { code, map } object, or nothing/null` );
			})
			.then( source => {
				if ( typeof source === 'string' ) {
					source = {
						code: source,
						ast: null
					};
				}

				if ( this.cachedModules.has( id ) && this.cachedModules.get( id ).originalCode === source.code ) {
					return this.cachedModules.get( id );
				}

				return transform( source, id, this.plugins );
			})
			.then( source => {
				const { code, originalCode, originalSourceMap, ast, sourceMapChain } = source;

				const module = new Module({
					id,
					code,
					originalCode,
					originalSourceMap,
					ast,
					sourceMapChain,
					bundle: this
				});

				this.modules.push( module );
				this.moduleById.set( id, module );

				return this.fetchAllDependencies( module ).then( () => {
					keys( module.exports ).forEach( name => {
						module.exportsAll[name] = module.id;
					});
					module.exportAllSources.forEach( source => {
						const id = module.resolvedIds[ source ];
						const exportAllModule = this.moduleById.get( id );
						if ( exportAllModule.isExternal ) return;

						keys( exportAllModule.exportsAll ).forEach( name => {
							if ( name in module.exportsAll ) {
								this.onwarn( `Conflicting namespaces: ${module.id} re-exports '${name}' from both ${module.exportsAll[ name ]} (will be ignored) and ${exportAllModule.exportsAll[ name ]}.` );
							}
							module.exportsAll[ name ] = exportAllModule.exportsAll[ name ];
						});
					});
					return module;
				});
			});
	}

	fetchAllDependencies ( module ) {
		return mapSequence( module.sources, source => {
			const resolvedId = module.resolvedIds[ source ];
			return ( resolvedId ? Promise.resolve( resolvedId ) : this.resolveId( source, module.id ) )
				.then( resolvedId => {
					const externalId = resolvedId || (
						isRelative( source ) ? resolve( module.id, '..', source ) : source
					);

					let isExternal = this.isExternal( externalId );

					if ( !resolvedId && !isExternal ) {
						if ( isRelative( source ) ) throw new Error( `Could not resolve '${source}' from ${module.id}` );

						this.onwarn( `Treating '${source}' as external dependency` );
						isExternal = true;
					}

					if ( isExternal ) {
						module.resolvedIds[ source ] = externalId;

						if ( !this.moduleById.has( externalId ) ) {
							const module = new ExternalModule( externalId, this.getPath( externalId ) );
							this.externalModules.push( module );
							this.moduleById.set( externalId, module );
						}
					} else {
						if ( resolvedId === module.id ) {
							throw new Error( `A module cannot import itself (${resolvedId})` );
						}

						module.resolvedIds[ source ] = resolvedId;
						return this.fetchModule( resolvedId, module.id );
					}
				});
		});
	}

	getPathRelativeToEntryDirname ( resolvedId ) {
		if ( isRelative( resolvedId ) || isAbsolute( resolvedId ) ) {
			const entryDirname = dirname( this.entryId );
			const relativeToEntry = normalize( relative( entryDirname, resolvedId ) );

			return isRelative( relativeToEntry ) ? relativeToEntry : `./${relativeToEntry}`;
		}

		return resolvedId;
	}

	render ( options = {} ) {
		if ( options.format === 'es6' ) {
			this.onwarn( 'The es6 format is deprecated – use `es` instead' );
			options.format = 'es';
		}

		const format = options.format || 'es';

		// Determine export mode - 'default', 'named', 'none'
		const exportMode = getExportMode( this, options );

		let magicString = new MagicStringBundle({ separator: '\n\n' });
		const usedModules = [];

		timeStart( 'render modules' );

		this.orderedModules.forEach( module => {
			const source = module.render( format === 'es', this.legacy );

			if ( source.toString().length ) {
				magicString.addSource( source );
				usedModules.push( module );
			}
		});

		timeEnd( 'render modules' );

		let intro = [ options.intro ]
			.concat(
				this.plugins.map( plugin => plugin.intro && plugin.intro() )
			)
			.filter( Boolean )
			.join( '\n\n' );

		if ( intro ) intro += '\n';

		const indentString = getIndentString( magicString, options );

		const finalise = finalisers[ format ];
		if ( !finalise ) throw new Error( `You must specify an output type - valid options are ${keys( finalisers ).join( ', ' )}` );

		timeStart( 'render format' );

		magicString = finalise( this, magicString.trim(), { exportMode, indentString, intro }, options );

		timeEnd( 'render format' );

		const banner = [ options.banner ]
			.concat( this.plugins.map( plugin => plugin.banner ) )
			.map( callIfFunction )
			.filter( Boolean )
			.join( '\n' );

		const footer = [ options.footer ]
			.concat( this.plugins.map( plugin => plugin.footer ) )
			.map( callIfFunction )
			.filter( Boolean )
			.join( '\n' );

		if ( banner ) magicString.prepend( banner + '\n' );
		if ( footer ) magicString.append( '\n' + footer );

		let code = magicString.toString();
		let map = null;
		const bundleSourcemapChain = [];

		code = transformBundle( code, this.plugins, bundleSourcemapChain, options )
			.replace( new RegExp( `\\/\\/#\\s+${SOURCEMAPPING_URL}=.+\\n?`, 'g' ), '' );

		if ( options.sourceMap ) {
			timeStart( 'sourceMap' );

			let file = options.sourceMapFile || options.dest;
			if ( file ) file = resolve( typeof process !== 'undefined' ? process.cwd() : '', file );

			if ( this.hasLoaders || find( this.plugins, plugin => plugin.transform || plugin.transformBundle ) ) {
				map = magicString.generateMap( {} );
				if ( typeof map.mappings === 'string' ) {
					map.mappings = decode( map.mappings );
				}
				map = collapseSourcemaps( file, map, usedModules, bundleSourcemapChain, this.onwarn );
			} else {
				map = magicString.generateMap({ file, includeContent: true });
			}

			map.sources = map.sources.map( normalize );

			timeEnd( 'sourceMap' );
		}

		if ( code[ code.length - 1 ] !== '\n' ) code += '\n';
		return { code, map };
	}

	sort () {
		let hasCycles;
		const seen = {};
		const ordered = [];

		const stronglyDependsOn = blank();
		const dependsOn = blank();

		this.modules.forEach( module => {
			stronglyDependsOn[ module.id ] = blank();
			dependsOn[ module.id ] = blank();
		});

		this.modules.forEach( module => {
			function processStrongDependency ( dependency ) {
				if ( dependency === module || stronglyDependsOn[ module.id ][ dependency.id ] ) return;

				stronglyDependsOn[ module.id ][ dependency.id ] = true;
				dependency.strongDependencies.forEach( processStrongDependency );
			}

			function processDependency ( dependency ) {
				if ( dependency === module || dependsOn[ module.id ][ dependency.id ] ) return;

				dependsOn[ module.id ][ dependency.id ] = true;
				dependency.dependencies.forEach( processDependency );
			}

			module.strongDependencies.forEach( processStrongDependency );
			module.dependencies.forEach( processDependency );
		});

		const visit = module => {
			if ( seen[ module.id ] ) {
				hasCycles = true;
				return;
			}

			seen[ module.id ] = true;

			module.dependencies.forEach( visit );
			ordered.push( module );
		};

		visit( this.entryModule );

		if ( hasCycles ) {
			ordered.forEach( ( a, i ) => {
				for ( i += 1; i < ordered.length; i += 1 ) {
					const b = ordered[i];

					if ( stronglyDependsOn[ a.id ][ b.id ] ) {
						// somewhere, there is a module that imports b before a. Because
						// b imports a, a is placed before b. We need to find the module
						// in question, so we can provide a useful error message
						let parent = '[[unknown]]';
						const visited = {};

						const findParent = module => {
							if ( dependsOn[ module.id ][ a.id ] && dependsOn[ module.id ][ b.id ] ) {
								parent = module.id;
								return true;
							}
							visited[ module.id ] = true;
							for ( let i = 0; i < module.dependencies.length; i += 1 ) {
								const dependency = module.dependencies[i];
								if ( !visited[ dependency.id ] && findParent( dependency ) ) return true;
							}
						};

						findParent( this.entryModule );

						this.onwarn(
							`Module ${a.id} may be unable to evaluate without ${b.id}, but is included first due to a cyclical dependency. Consider swapping the import statements in ${parent} to ensure correct ordering`
						);
					}
				}
			});
		}

		return ordered;
	}
}
