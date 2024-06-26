import {
  addDomainToVercel,
  domainExists,
  setRootDomain,
} from "@/lib/api/domains";
import { DubApiError } from "@/lib/api/errors";
import { withSession } from "@/lib/auth";
import { checkIfUserExists } from "@/lib/planetscale";
import prisma from "@/lib/prisma";
import { createWorkspaceSchema } from "@/lib/zod/schemas";
import { FREE_WORKSPACES_LIMIT, nanoid } from "@dub/utils";
import { NextResponse } from "next/server";

// GET /api/workspaces - get all projects for the current user
export const GET = withSession(async ({ session }) => {
  const projects = await prisma.project.findMany({
    where: {
      users: {
        some: {
          userId: session.user.id,
        },
      },
    },
    include: {
      users: {
        where: {
          userId: session.user.id,
        },
        select: {
          role: true,
        },
      },
      domains: {
        select: {
          slug: true,
          primary: true,
        },
      },
    },
  });
  return NextResponse.json(
    projects.map((project) => ({ ...project, id: `ws_${project.id}` })),
  );
});

export const POST = withSession(async ({ req, session }) => {
  const { name, slug, domain } = await createWorkspaceSchema.parseAsync(
    await req.json(),
  );

  const userExists = await checkIfUserExists(session.user.id);

  if (!userExists) {
    throw new DubApiError({
      code: "not_found",
      message: "Session expired. Please log in again.",
    });
  }

  const freeWorkspaces = await prisma.project.count({
    where: {
      plan: "free",
      users: {
        some: {
          userId: session.user.id,
          role: "owner",
        },
      },
    },
  });

  if (freeWorkspaces >= FREE_WORKSPACES_LIMIT) {
    throw new DubApiError({
      code: "exceeded_limit",
      message: `You can only create up to ${FREE_WORKSPACES_LIMIT} free workspaces. Additional workspaces require a paid plan.`,
    });
  }

  const [slugExist, domainExist] = await Promise.all([
    prisma.project.findUnique({
      where: {
        slug,
      },
      select: {
        slug: true,
      },
    }),
    domain ? domainExists(domain) : false,
  ]);

  if (slugExist) {
    throw new DubApiError({
      code: "conflict",
      message: "Slug is already in use.",
    });
  }

  if (domainExist) {
    throw new DubApiError({
      code: "conflict",
      message: "Domain is already in use.",
    });
  }

  const [projectResponse, domainRepsonse] = await Promise.all([
    prisma.project.create({
      data: {
        name,
        slug,
        users: {
          create: {
            userId: session.user.id,
            role: "owner",
          },
        },
        ...(domain && {
          domains: {
            create: {
              slug: domain,
              primary: true,
            },
          },
        }),
        billingCycleStart: new Date().getDate(),
        inviteCode: nanoid(24),
        defaultDomains: {
          create: {}, // by default, we give users all the default domains when they create a project
        },
      },
      include: {
        domains: {
          select: {
            id: true,
            slug: true,
            primary: true,
          },
        },
        users: {
          select: {
            role: true,
          },
        },
      },
    }),
    domain && addDomainToVercel(domain),
  ]);

  // if domain is specified and it was successfully added to Vercel
  // update it in Redis cache
  if (domain && domainRepsonse && !domainRepsonse.error) {
    await setRootDomain({
      id: projectResponse.domains[0].id,
      domain,
      projectId: projectResponse.id,
    });
  }

  const response = {
    ...projectResponse,
    id: `ws_${projectResponse.id}`,
    domains: projectResponse.domains.map(({ slug, primary }) => ({
      slug,
      primary,
    })),
  };

  return NextResponse.json(response);
});
