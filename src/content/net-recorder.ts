/**
 * Tarka Network Recorder (MAIN World Content Script Entry)
 * Runs at document_start in MAIN world to intercept window.fetch and XMLHttpRequest.
 */
import { installNetCapture } from './netCapture.ts';

installNetCapture(window as unknown as Parameters<typeof installNetCapture>[0]);
