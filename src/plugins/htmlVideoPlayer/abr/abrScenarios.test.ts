import { describe, expect, it } from 'vitest';

import { createCases, createPolicyAlgorithm, createRobustGroups, MBPS, type ScenarioCase } from './abrSimScenarios';
import { runSimulation, type SimMetrics, type SimScenario } from './abrSimulator';
import { createLegacyGovernorAlgorithm } from './legacyGovernorAdapter';

/** Cases where one run is too noisy to compare. The robust groups check them instead. */
const NOISY_CASES = new Set(['5 square wave', '6 random walk', '15 late buffer report']);
const MIN_QUALITY_RATIO = 0.95;

function runBoth(testCase: ScenarioCase) {
    const options = { highBitrateBrowser: testCase.highBitrateBrowser, levels: testCase.scenario.levels };
    return {
        legacy: runSimulation(testCase.scenario, createLegacyGovernorAlgorithm(options)),
        next: runSimulation(testCase.scenario, createPolicyAlgorithm(options))
    };
}

function formatRow(name: string, algorithm: string, metrics: SimMetrics) {
    return [
        name.padEnd(26),
        algorithm.padEnd(7),
        String(metrics.stallCount).padStart(6),
        metrics.stallSeconds.toFixed(1).padStart(7),
        String(metrics.switches).padStart(5),
        String(metrics.downSwitches).padStart(5),
        String(metrics.emergencies).padStart(5),
        (metrics.averageBitrate / MBPS).toFixed(2).padStart(7),
        (metrics.startupMs / 1000).toFixed(1).padStart(6),
        metrics.timeToTopSeconds.toFixed(0).padStart(6),
        `${metrics.minBufferCapSeconds}-${metrics.maxBufferCapSeconds}`.padStart(7)
    ].join(' ');
}

function printTimelines(segmentDurationSeconds: number, results: Record<string, Record<string, SimMetrics>>) {
    // Set ABR_TIMELINE to part of a scenario name to print its level changes.
    const filter = process.env.ABR_TIMELINE;
    if (!filter) {
        return;
    }

    for (const [name, result] of Object.entries(results).filter(([caseName]) => caseName.includes(filter))) {
        for (const [algorithm, metrics] of Object.entries(result)) {
            const timeline = metrics.levelTimeline
                .map(entry => `${entry.atSeconds.toFixed(0)}s:L${entry.level}`)
                .join(' ');
            console.log(`TIMELINE ${segmentDurationSeconds}s ${name} ${algorithm}: ${timeline}`);
        }
    }
}

function getTopLevelEntryTimes(metrics: SimMetrics, topLevel: number) {
    return metrics.levelTimeline
        .filter(entry => entry.level === topLevel)
        .map(entry => entry.atSeconds);
}

function sumMetrics(scenarios: SimScenario[], algorithm: 'legacy' | 'next') {
    const total = { averageBitrate: 0, stallCount: 0, stallSeconds: 0, switches: 0 };
    for (const scenario of scenarios) {
        const options = { levels: scenario.levels };
        const metrics = runSimulation(
            scenario,
            algorithm === 'legacy' ? createLegacyGovernorAlgorithm(options) : createPolicyAlgorithm(options)
        );
        total.averageBitrate += metrics.averageBitrate / scenarios.length;
        total.stallCount += metrics.stallCount;
        total.stallSeconds += metrics.stallSeconds;
        total.switches += metrics.switches / scenarios.length;
    }
    return total;
}

describe.each([3, 6])('ABR scenarios with %i s segments', segmentDurationSeconds => {
    const cases = createCases(segmentDurationSeconds);
    const results = Object.fromEntries(Object.entries(cases).map(([name, testCase]) => [name, runBoth(testCase)]));

    it('prints the comparison table', () => {
        const header = 'scenario                   algo    stalls  stallS  swit  down  emer    Mbps  start  top_s    cap';
        const rows = Object.entries(results).flatMap(([name, result]) => [
            formatRow(name, 'old', result.legacy),
            formatRow('', 'new', result.next)
        ]);
        console.log(`\nsegment ${segmentDurationSeconds}s\n${header}\n${rows.join('\n')}`);
        printTimelines(segmentDurationSeconds, results);
        expect(rows).toHaveLength(Object.keys(cases).length * 2);
    });

    it.each(Object.keys(cases))('%s: no more stalls than the old governor', name => {
        const { legacy, next } = results[name];
        expect(next.stallCount).toBeLessThanOrEqual(legacy.stallCount);
        expect(next.stallSeconds).toBeLessThanOrEqual(legacy.stallSeconds + 0.05);
    });

    it.each(Object.keys(cases).filter(name => !NOISY_CASES.has(name)))(
        '%s: at least 95 % of the old quality, unless the old governor stalled more',
        name => {
            const { legacy, next } = results[name];
            if (legacy.stallSeconds <= next.stallSeconds) {
                expect(next.averageBitrate).toBeGreaterThanOrEqual(legacy.averageBitrate * MIN_QUALITY_RATIO);
            }
        }
    );

    it('1: a fast network reaches the top level with no stalls', () => {
        const { legacy, next } = results['1 stable fast'];
        expect(next.stallCount).toBe(0);
        expect(next.timeToTopSeconds).toBeGreaterThanOrEqual(0);
        expect(next.startupMs).toBeLessThanOrEqual(legacy.startupMs);
    });

    it('2: a slow network stays on the safe level', () => {
        const { next } = results['2 stable slow'];
        expect(next.stallCount).toBe(0);
        expect(next.levelTimeline[next.levelTimeline.length - 1].level).toBe(2);
    });

    it('4: reaches the top level within 60 s after the network gets faster', () => {
        const { next } = results['4 rise 3->30'];
        expect(next.timeToTopSeconds).toBeGreaterThanOrEqual(60);
        expect(next.timeToTopSeconds).toBeLessThanOrEqual(120);
    });

    it('7: slow transcoding of high levels causes no stalls', () => {
        expect(results['7 slow transcode'].next.stallCount).toBe(0);
    });

    it('8: stalls with a full buffer do not lower the quality', () => {
        const { legacy, next } = results['8 decoder stalls'];
        expect(legacy.downSwitches).toBeGreaterThan(0);
        expect(next.downSwitches).toBe(0);
    });

    it('9: the wait before a new try of a failing level grows', () => {
        const { next } = results['9 failing top level'];
        const entryTimes = getTopLevelEntryTimes(next, cases['9 failing top level'].scenario.levels.length - 1);
        const gaps = entryTimes.slice(1).map((time, index) => time - entryTimes[index]);
        expect(next.stallCount).toBe(0);
        expect(gaps.length).toBeGreaterThan(0);
        for (let index = 1; index < gaps.length; index++) {
            expect(gaps[index]).toBeGreaterThanOrEqual(gaps[index - 1]);
        }
    });

    it('10: one large VBR segment does not lower the quality', () => {
        expect(results['10 vbr spikes'].next.downSwitches).toBe(0);
    });

    it('11: the 6 s buffer limit does not apply to low levels', () => {
        const { legacy, next } = results['11 small cap, low level'];
        expect(legacy.maxBufferCapSeconds).toBe(6);
        expect(next.minBufferCapSeconds).toBeGreaterThan(6);
    });

    describe.each(Object.entries(createRobustGroups(segmentDurationSeconds)))('%s (many runs)', (_name, scenarios) => {
        const legacy = sumMetrics(scenarios, 'legacy');
        const next = sumMetrics(scenarios, 'next');

        it('has no more stalls and at least 95 % of the old quality', () => {
            console.log(`${_name} ${segmentDurationSeconds}s: old ${legacy.stallCount} stalls, ${legacy.switches.toFixed(1)} switches, ${(legacy.averageBitrate / MBPS).toFixed(2)} Mbps / new ${next.stallCount} stalls, ${next.switches.toFixed(1)} switches, ${(next.averageBitrate / MBPS).toFixed(2)} Mbps`);
            expect(next.stallCount).toBeLessThanOrEqual(legacy.stallCount);
            expect(next.stallSeconds).toBeLessThanOrEqual(legacy.stallSeconds + 0.05);
            expect(next.averageBitrate).toBeGreaterThanOrEqual(legacy.averageBitrate * MIN_QUALITY_RATIO);
        });
    });
});
