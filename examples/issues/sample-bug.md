# Sample Bug

## Title

Node demo returns the wrong upstream status code for failed outbound calls

## Description

When the upstream dependency returns a `404`, the app responds with `500` instead of preserving the upstream error semantics.

## Expected Result

The app should return a stable client-visible error response for upstream `404` cases.

## Validation Hint

Use the captured replay dataset for this route and confirm that the fixed build no longer returns a generic `500`.
