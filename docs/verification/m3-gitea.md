# M3 Gitea transport acceptance

The dedicated Electron test passed on Linux in 8.8 seconds against Gitea 1.26.4 in a rootless Podman container. The image was `docker.io/gitea/gitea:1.26.4-rootless`; its reported manifest digests were `sha256:b9d89b3b13561f7ffcb9eac85ac85e38b3f430fba251cdb2d3a8b6be0745c72b` and `sha256:cd1d2614b403fc9b085fa52ceb4424dde9c4dcf5da8e3263abb27955562070c4`.

The test creates a private repository and exercises the real desktop, Git service, native helper and server:

- HTTPS clone with username/password dialogs and certificate verification against a test CA.
- Push review and rejection when the server has newer commits; the local branch is unchanged.
- SSH clone with an unknown host key: declining refuses the connection, then explicit confirmation permits it.
- An encrypted Ed25519 key prompts for its passphrase and completes the SSH clone.

All credentials and keys are disposable fixtures. HTTPS and SSH bind only loopback, use random ports and leave system Git/SSH configuration alone. Containers and temporary repositories are removed after the test. No TLS bypass is used. Ordinary tests skip this optional fixture; the Linux CI job enables it explicitly. The existing bare-remote suite covers normal push, stale reviews and force-with-lease rejection.

Run after `pnpm build`, with Docker available:

```sh
OPENKRAKEN_GITEA_TEST=1 xvfb-run -a pnpm exec playwright test tests/e2e/gitea.test.ts
```

`OPENKRAKEN_CONTAINER_ENGINE` can select a Podman executable; the fixture then uses its keep-id user namespace. `OPENKRAKEN_GITEA_IMAGE` can select a preloaded image. On this machine Podman and its dependencies were extracted into the developer tool cache; no system package installation or daemon was required.

This establishes Linux transport acceptance. It does not establish Windows named-pipe or macOS execution. Pull policy and server-ref deletion are separate M3 work. The fixture follows Gitea's [rootless container documentation](https://docs.gitea.com/installation/install-with-docker-rootless/).
