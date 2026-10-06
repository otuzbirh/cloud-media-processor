# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Users prepare image batches for web publishing. Researchers also compare static, CPU-based, and queue-based cloud worker allocation.

## Product Purpose

Cloud Media Processor combines batch image optimization with an experimental dashboard for observing queue, worker, throughput, latency, and capacity behavior.

## Positioning

The product exposes the same real asynchronous media pipeline as both a practical processing workspace and a controlled cloud-scaling experiment.

## Operating Context

Users upload JPEG, PNG, or WebP files, select a processing profile, tune the pipeline, monitor jobs, download outputs, revisit batch history, and record experiment sessions.

## Capabilities and Constraints

- Up to 30 files per batch and 15 MB per file.
- Conversion, resize, compression, thumbnails, metadata removal, and text watermarking.
- BullMQ and Redis job processing with MinIO output storage.
- Static, CPU HPA, and queue/KEDA deployment policies.
- Bosnian interface copy.
- Real metrics only; unconfigured cost data must remain clearly labeled as unavailable.

## Brand Commitments

The product name is Cloud Media Processor. Interface language is direct, operational, and evidence-led.

## Evidence on Hand

Runtime behavior, supported workflows, metrics, and architecture are documented in `README.md` and implemented in `app/page.tsx` plus `services/`.

## Product Principles

- Keep batch progress and recovery visible.
- Separate operational actions from experimental measurement.
- Show measured data without invented claims.
- Keep advanced configuration understandable without hiding capability.

## Accessibility & Inclusion

The interface supports keyboard focus, reduced motion, responsive layouts, and status text that does not depend on color alone.
