import * as ts_module from 'typescript/lib/tsserverlibrary';
import {globalExclude, excludeAll, excludeMembers} from './exclude';

declare module 'typescript/lib/tsserverlibrary' {
    function getTokenAtPosition(sf: SourceFile, position: number): Node;
    interface TypeChecker {
        isArrayLikeType(arrayType: ts.Type): arrayType is ts.TypeReference;
    }
}

function init(modules: {typescript: typeof ts_module}) {
    const ts = modules.typescript;
    function create(info: ts.server.PluginCreateInfo) {
        const proxy: ts.LanguageService = Object.create(null);
        for (let k of Object.keys(info.languageService) as Array<keyof ts.LanguageService>) {
            const x = info.languageService[k];
            proxy[k] = (...args: Array<{}>) => {
                return (x as any).apply(info.languageService, args);
            };
        }
        function typeToString(type: ts.Type, checker: ts.TypeChecker) {
            if (type.flags & ts.TypeFlags.NumberLike) return '0';
            if (type.flags & ts.TypeFlags.StringLike) return "''";
            if (type.flags & ts.TypeFlags.BooleanLike) return 'true';
            if (checker.isArrayLikeType(type)) return `[{}]`;
            return '{}';
        }
        function getInfo(fileName: string, position: number) {
            const program = info.project.getLanguageService().getProgram()!;
            const checker = program.getTypeChecker();
            const sourceFile = program.getSourceFile(fileName);
            const result: {
                propName?: string;
                propType?: ts.Type;
                checker: ts.TypeChecker;
                sourceFile?: ts.SourceFile;
                originalInterfaceType?: ts.Type;
                access?: ts.PropertyAccessExpression;
                queryObject?: ts.ObjectLiteralExpression;
            } = {
                sourceFile,
                checker,
                access: undefined,
                originalInterfaceType: undefined,
                queryObject: undefined,
                propName: undefined,
                propType: undefined,
            };
            function getTypeDeclaration(type: ts.Type | undefined) {
                return type && getSymbolDeclaration(type.symbol);
            }
            function getSymbolDeclaration(symbol: ts.Symbol | undefined) {
                return symbol && symbol.declarations && symbol.declarations.length > 0 && symbol.declarations[0];
            }

            if (sourceFile) {
                const token = ts.getTokenAtPosition(sourceFile, position);
                const access = token.parent;
                if (access && ts.isPropertyAccessExpression(access)) {
                    result.access = access;
                    if (access) {
                        result.propName = access.name.text;
                        const parentDeclInitializer = getTypeDeclaration(checker.getTypeAtLocation(access.expression));
                        if (
                            parentDeclInitializer &&
                            ts.isObjectLiteralExpression(parentDeclInitializer) &&
                            parentDeclInitializer.parent
                        ) {
                            const parentDecl = parentDeclInitializer.parent;
                            let type;
                            if (
                                parentDecl &&
                                ts.isArrayLiteralExpression(parentDecl) &&
                                parentDecl.elements.length > 0
                            ) {
                                const el = parentDecl.elements[0];
                                type = checker.getContextualType(el);
                                if (ts.isObjectLiteralExpression(el)) {
                                    result.queryObject = el;
                                }
                            } else if (
                                parentDecl &&
                                ts.isPropertyAssignment(parentDecl) &&
                                ts.isObjectLiteralExpression(parentDecl.initializer) &&
                                ts.isIdentifier(parentDecl.name)
                            ) {
                                type = checker.getContextualType(parentDecl.name);
                                result.queryObject = parentDecl.initializer;
                            }
                            if (type && type.isUnion()) {
                                const originalInterfaceType = type.types.find(
                                    t => getTypeDeclaration(t) !== parentDecl,
                                );
                                result.originalInterfaceType = originalInterfaceType;
                                if (originalInterfaceType) {
                                    const identDeclaration = getSymbolDeclaration(
                                        originalInterfaceType
                                            .getProperties()
                                            .find(symbol => symbol.escapedName === access.name.text),
                                    );
                                    if (identDeclaration) {
                                        result.propType = checker.getTypeAtLocation(identDeclaration);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            return result;
        }
        proxy.getCodeFixesAtPosition = (fileName, start, end, errorCodes, formatOptions, preferences) => {
            let res = info.languageService.getCodeFixesAtPosition(
                fileName,
                start,
                end,
                errorCodes,
                formatOptions,
                preferences,
            );
            if (errorCodes.includes(2339)) {
                const {propName, propType, queryObject, checker} = getInfo(fileName, start);
                if (propName && queryObject && propType) {
                    const hasOtherProps = queryObject.properties.length > 0;
                    const start = hasOtherProps
                        ? queryObject.properties[queryObject.properties.length - 1].end
                        : queryObject.getStart() + 1;
                    res = [
                        ...res,
                        {
                            fixName: 'Add field to graphql query',
                            description: 'Add field to graphql query',
                            changes: [
                                {
                                    fileName: queryObject.getSourceFile().fileName,
                                    textChanges: [
                                        {
                                            newText:
                                                (hasOtherProps ? ', ' : '') +
                                                propName +
                                                ': ' +
                                                typeToString(propType, checker),
                                            span: {
                                                start,
                                                length: 0,
                                            },
                                        },
                                    ],
                                },
                            ],
                        },
                    ];
                }
            }
            return res;
        };
        proxy.getCompletionsAtPosition = (fileName, position, options) => {
            let prior = info.languageService.getCompletionsAtPosition(fileName, position, options);
            if (prior) {
                prior.entries = prior.entries.filter(entry => !excludeAll.has(entry.name));
                if (prior.isGlobalCompletion) {
                    prior.entries = prior.entries.filter(entry => !globalExclude.has(entry.name));
                }
                if (prior.isMemberCompletion) {
                    prior.entries = prior.entries.filter(entry => !excludeMembers.has(entry.name));
                }
            }
            const {originalInterfaceType} = getInfo(fileName, position - 1);
            if (originalInterfaceType) {
                if (!prior)
                    prior = {
                        isGlobalCompletion: false,
                        isMemberCompletion: true,
                        isNewIdentifierLocation: false,
                        entries: [],
                    };
                prior.entries = [
                    ...prior.entries,
                    ...originalInterfaceType
                        .getProperties()
                        .filter(symbol => prior!.entries.every(entry => entry.name !== symbol.name))
                        .map<ts.CompletionEntry>(symbol => ({
                            name: symbol.name,
                            insertText: symbol.name,
                            isRecommended: true,
                            kind: ts.ScriptElementKind.interfaceElement,
                            sortText: '0',
                        })),
                ];
            }

            return prior;
        };
        return proxy;
    }
    return {create};
}

export = init;
