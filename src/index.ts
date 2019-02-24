import * as ts_module from 'typescript/lib/tsserverlibrary';
import {globalExclude, excludeAll, excludeMembers} from './exclude';

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
        proxy.getCompletionsAtPosition = (fileName, position, options) => {
            const prior = info.languageService.getCompletionsAtPosition(fileName, position, options);
            if (prior) {
                prior.entries = prior.entries.filter(entry => !excludeAll.has(entry.name));
                if (prior.isGlobalCompletion) {
                    prior.entries = prior.entries.filter(entry => !globalExclude.has(entry.name));
                }
                if (prior.isMemberCompletion) {
                    prior.entries = prior.entries.filter(entry => !excludeMembers.has(entry.name));
                }
            }
            return prior;
        };
        return proxy;
    }
    return {create};
}

export = init;
